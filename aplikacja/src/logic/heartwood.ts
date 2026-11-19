// Heartwood file sync as seen by the app: the platform port, the
// local API types (contract section 9) and pure helpers. Paths, names
// and reasons from the daemon are data, never control text.
import { AppError } from './errors.js';
import { readJson, writeJson, type KeyValueStore } from './storage.js';

/** Daemon state reported by the Rust supervisor. */
export type HwState = 'disabled' | 'not_installed' | 'starting' | 'running' | 'restarting';

/** Supervisor info (`heartwood_info`). */
export interface HwInfo { state: HwState; root: string; restarts: number; lastError: string | null }

/** Commands the Rust side lets through to the daemon. */
export type HwCommand = 'status' | 'lock' | 'release' | 'request-release' | 'history' | 'download' | 'restore' | 'select' | 'unselect';

/** One local API request line. */
export interface HwRequest { cmd: HwCommand; [field: string]: unknown }

/** One reply line: `{ ok: true, … }` or `{ ok: false, code, message }`. */
export type HwReply = Record<string, unknown>;

/** Platform effects of the files feature (background window only). */
export interface HeartwoodPort {
  /** Starts (or keeps) the daemon; rejects with a code string. */
  start(serverUrl: string, wsUrl: string, org: string): Promise<HwInfo>;
  /** Stops the daemon (logout). */
  stop(): Promise<void>;
  /** Current supervisor state. */
  info(): Promise<HwInfo>;
  /** One local API call; rejects with a transport code string. */
  call(req: HwRequest): Promise<HwReply>;
  /** OS picker for files under `root`; `[]` when cancelled. */
  pickFiles(root: string): Promise<string[]>;
}

/** One selected space. */
export interface HwSpace { space: string; folder: string; lastSeq: number; serverSeq: number | null; unsent: number }
/** One outbox row. */
export interface HwPending { space: string; op: string; path: string; toPath?: string; status: string; message?: string }
/** One conflict with the local copy's path. */
export interface HwConflict { space: string; path: string; copyPath: string; at: string; message: string }
/** One skipped path with a Polish reason and hint. */
export interface HwSkipped { space: string; path: string; reason: string; reasonText: string; suggestion?: string; hint?: string }
/** One current problem (`space` empty = general). */
export interface HwIssue { space: string; message: string }

/** The `status` answer. */
export interface HwStatus {
  running: boolean;
  connected: boolean;
  spaces: HwSpace[];
  pending: HwPending[];
  conflicts: HwConflict[];
  skipped: HwSkipped[];
  issues: HwIssue[];
}

/** One version of a file (`VersionRecord` of the Heartwood API). */
export interface HwVersion {
  seq: number;
  versionId: string;
  sha256: string;
  size: number;
  author: string;
  workId?: string;
  at: string;
  kind: 'put' | 'restore' | 'move' | 'delete';
  fromSeq?: number;
  fromPath?: string;
}

/** Counts shown next to the clock. */
export interface FileCounts { conflicts: number; unsent: number }

/** The files part of the view. */
export interface FilesView { info: HwInfo; status: HwStatus | null; counts: FileCounts }

/** Info used before the supervisor answered. */
export const DISABLED_INFO: Readonly<HwInfo> = Object.freeze({ state: 'disabled', root: '', restarts: 0, lastError: null });

const LOCKS_KEY = 'cognifly.heartwood.locks';
const CODE = /^[A-Z][A-Z_]{0,39}$/;
const VERSION_KINDS: readonly string[] = ['put', 'restore', 'move', 'delete'];

/** Polish texts of app-side codes; daemon refusals bring their own. */
const MESSAGES: Readonly<Record<string, string>> = {
  NOT_RUNNING: 'Heartwood nie działa — uruchamiam ponownie…',
  NOT_INSTALLED: 'Heartwood nie jest zainstalowany na tym komputerze.',
  DISABLED: 'Pliki nie są jeszcze włączone w tej wersji CogniFly.',
  TIMEOUT: 'Heartwood nie odpowiada.',
};

/**
 * Reads the `status` reply.
 *
 * Call: `parseStatus(reply)`.
 * Expects: anything (untrusted JSON from the daemon).
 * Output: the status with `null` optional texts dropped, or `null`
 * when the reply is a refusal or any part is malformed.
 */
export function parseStatus(v: unknown): HwStatus | null {
  const o = record(v);
  if (!o || o.ok === false || typeof o.running !== 'boolean' || typeof o.connected !== 'boolean') return null;
  const spaces = list(o.spaces, parseSpace);
  const pending = list(o.pending, (x) => texts(x, ['space', 'op', 'path', 'status'], ['toPath', 'message']) as HwPending | null);
  const conflicts = list(o.conflicts, (x) => texts(x, ['space', 'path', 'copyPath', 'at', 'message']) as HwConflict | null);
  const skipped = list(o.skipped, (x) => texts(x, ['space', 'path', 'reason', 'reasonText'], ['suggestion', 'hint']) as HwSkipped | null);
  const issues = list(o.issues, (x) => texts(x, ['space', 'message']) as HwIssue | null);
  if (!spaces || !pending || !conflicts || !skipped || !issues) return null;
  return { running: o.running, connected: o.connected, spaces, pending, conflicts, skipped, issues };
}

/**
 * Reads one space row.
 *
 * Call: `parseSpace(row)` via `list`.
 * Expects: anything.
 * Output: the row, or `null` when a field is missing or mistyped.
 */
function parseSpace(v: unknown): HwSpace | null {
  const t = texts(v, ['space', 'folder']);
  const o = record(v);
  if (!t || !o || !isCount(o.lastSeq) || !isCount(o.unsent)) return null;
  if (o.serverSeq !== null && !isCount(o.serverSeq)) return null;
  return { space: t.space!, folder: t.folder!, lastSeq: o.lastSeq, serverSeq: o.serverSeq, unsent: o.unsent };
}

/**
 * Reads the versions of a `history` reply.
 *
 * Call: `parseVersions(reply.versions)`.
 * Expects: anything.
 * Output: well-formed `VersionRecord`s only (others are dropped).
 */
export function parseVersions(v: unknown): HwVersion[] {
  if (!Array.isArray(v)) return [];
  return v.map(parseVersion).filter((x): x is HwVersion => x !== null);
}

/**
 * Reads one version record.
 *
 * Call: `parseVersion(item)`.
 * Expects: anything.
 * Output: the record, or `null` when malformed.
 */
function parseVersion(v: unknown): HwVersion | null {
  const t = texts(v, ['versionId', 'sha256', 'author', 'at', 'kind'], ['workId', 'fromPath']);
  const o = record(v);
  if (!t || !o || !VERSION_KINDS.includes(t.kind!) || !isCount(o.seq) || !isCount(o.size)) return null;
  if (o.fromSeq !== undefined && o.fromSeq !== null && !isCount(o.fromSeq)) return null;
  const from = isCount(o.fromSeq) ? { fromSeq: o.fromSeq } : {};
  return { ...t, seq: o.seq, size: o.size, ...from } as HwVersion;
}

/**
 * Picks string fields of an object.
 *
 * Call: `texts(v, ['space', 'path'], ['hint'])`.
 * Expects: anything; optional fields may be missing or `null`.
 * Output: an object with the required and present optional strings,
 * or `null` when a required field is not a string or an optional one
 * has another type.
 */
function texts(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, string> | null {
  const o = record(v);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const k of required) {
    if (typeof o[k] !== 'string') return null;
    out[k] = o[k];
  }
  for (const k of optional) {
    if (typeof o[k] === 'string') out[k] = o[k];
    else if (o[k] !== undefined && o[k] !== null) return null;
  }
  return out;
}

/**
 * Parses every item of an array.
 *
 * Call: `list(value, parseItem)`.
 * Expects: anything as `value`.
 * Output: the parsed items, or `null` when `value` is not an array
 * or any item fails.
 */
function list<T>(v: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(parse);
  return out.every((x) => x !== null) ? (out as T[]) : null;
}

/**
 * Narrows to a plain object.
 *
 * Call: `record(v)`.
 * Expects: anything.
 * Output: the object, or `null` for non-objects and arrays.
 */
function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Checks a non-negative integer.
 *
 * Call: `isCount(v)`.
 * Expects: anything.
 * Output: true for safe integers ≥ 0.
 */
function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

/**
 * Counts shown next to the clock (D12).
 *
 * Call: `fileCounts(status)`.
 * Expects: the last status or `null`.
 * Output: number of conflicts and the sum of `spaces[].unsent`.
 */
export function fileCounts(s: HwStatus | null): FileCounts {
  if (!s) return { conflicts: 0, unsent: 0 };
  return { conflicts: s.conflicts.length, unsent: s.spaces.reduce((n, sp) => n + sp.unsent, 0) };
}

/**
 * Builds the files part of the view.
 *
 * Call: `filesView(info, status)`.
 * Expects: supervisor info and the last status (or `null`).
 * Output: both plus their counts.
 */
export function filesView(info: HwInfo, status: HwStatus | null): FilesView {
  return { info, status, counts: fileCounts(status) };
}

/**
 * Heartwood work id of a task.
 *
 * Call: `workIdFor('zad_0123456789ab')`.
 * Expects: a checked task id.
 * Output: `cognifly:<id>`.
 */
export function workIdFor(taskId: string): string {
  return `cognifly:${taskId}`;
}

/**
 * Checks that a path lies inside the Heartwood root.
 *
 * Call: `isUnderRoot(path, root)`.
 * Expects: any strings; `root` absolute (trailing `/` allowed).
 * Output: true for an absolute path starting with `root/`, with
 * something after it, no `.`/`..`/empty segments and no control
 * characters; false for an empty root.
 */
export function isUnderRoot(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '');
  if (!base.startsWith('/') || !path.startsWith(`${base}/`) || /[\p{Cc}]/u.test(path)) return false;
  return path.slice(1).split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Groups paths by space folder (`<root>/<org>/<space>/…`).
 *
 * Call: `groupBySpace(paths, root)`.
 * Expects: paths already checked by `isUnderRoot`.
 * Output: groups in order of first appearance, so each lock or
 * release request stays within one space.
 */
export function groupBySpace(paths: readonly string[], root: string): string[][] {
  const base = root.replace(/\/+$/, '');
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = p.slice(base.length + 1).split('/').slice(0, 2).join('/');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()];
}

/**
 * Polish text for a files error.
 *
 * Call: `hwMessage(code, message?)`.
 * Expects: a code from the supervisor or the daemon; the daemon's
 * own Polish message when there is one.
 * Output: a fixed text for app-side codes, else the daemon message,
 * else `Nie udało się (<kod>).`.
 */
export function hwMessage(code: string, message?: string): string {
  return MESSAGES[code] ?? (message || `Nie udało się (${code}).`);
}

/**
 * Turns a rejected port call into an app error.
 *
 * Call: `throw hwError(e)` in a catch around a port call.
 * Expects: anything; the Rust commands reject with code strings.
 * Output: `AppError(code)` for a code string, else `e` unchanged
 * (mapped to `UNEXPECTED` by `errorCode`).
 */
export function hwError(e: unknown): unknown {
  return typeof e === 'string' && CODE.test(e) ? new AppError(e) : e;
}

/**
 * Checks a daemon reply.
 *
 * Call: `checkReply(reply)` after `call`.
 * Expects: the reply JSON.
 * Output: none for `ok: true`.
 * Throws: `AppError(code)` for a refusal (`BAD_RESPONSE` when the
 * code is missing or not a plain code).
 */
export function checkReply(reply: HwReply): void {
  if (reply.ok === true) return;
  throw new AppError(typeof reply.code === 'string' && CODE.test(reply.code) ? reply.code : 'BAD_RESPONSE');
}

/**
 * Paths this computer locked for a task (D11).
 *
 * Call: `lockedPaths(store, taskId)`.
 * Expects: any store; corrupt entries are ignored.
 * Output: the remembered absolute paths (may be empty).
 */
export function lockedPaths(store: KeyValueStore, taskId: string): string[] {
  const v = loadLocks(store)[taskId];
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
}

/**
 * Remembers newly locked paths of a task.
 *
 * Call: `rememberLocked(store, taskId, paths)`.
 * Expects: paths the daemon locked.
 * Output: none; stored without duplicates, order kept.
 */
export function rememberLocked(store: KeyValueStore, taskId: string, paths: readonly string[]): void {
  saveLocked(store, taskId, [...new Set([...lockedPaths(store, taskId), ...paths])]);
}

/**
 * Forgets released paths of a task.
 *
 * Call: `forgetLocked(store, taskId, paths)`.
 * Expects: paths the daemon released.
 * Output: none; a task without paths is removed from storage.
 */
export function forgetLocked(store: KeyValueStore, taskId: string, paths: readonly string[]): void {
  saveLocked(store, taskId, lockedPaths(store, taskId).filter((p) => !paths.includes(p)));
}

/**
 * Writes the paths of one task.
 *
 * Call: `saveLocked(store, taskId, paths)`.
 * Expects: the full new list for the task.
 * Output: none; an empty list drops the task's entry.
 */
function saveLocked(store: KeyValueStore, taskId: string, paths: string[]): void {
  const all = loadLocks(store);
  if (paths.length) all[taskId] = paths;
  else delete all[taskId];
  writeJson(store, LOCKS_KEY, all);
}

/**
 * Reads the lock memory.
 *
 * Call: `loadLocks(store)`.
 * Expects: any store.
 * Output: task id → stored value (unchecked items), `{}` if corrupt.
 */
function loadLocks(store: KeyValueStore): Record<string, unknown> {
  return record(readJson(store, LOCKS_KEY)) ?? {};
}
