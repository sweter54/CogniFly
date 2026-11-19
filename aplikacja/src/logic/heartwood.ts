// Heartwood file sync as seen by the app: the platform port, the
// local API types (contract section 9) and pure helpers. Paths, names
// and reasons from the daemon are data, never control text.
import { AppError, RefusalError } from './errors.js';
import { oneLine } from './notify.js';

/** Daemon state reported by the Rust supervisor. */
export type HwState = 'disabled' | 'not_installed' | 'starting' | 'running' | 'restarting';

/** Supervisor info (`heartwood_info`). */
export interface HwInfo { state: HwState; root: string; restarts: number; lastError: string | null }

/** Commands the Rust side lets through to the daemon. */
export type HwCommand =
  | 'status' | 'lock' | 'release' | 'request-release' | 'history' | 'download' | 'restore' | 'select' | 'unselect'
  | 'files' | 'work-files' | 'adopt' | 'resolve';

/** One local API request line. */
export interface HwRequest { cmd: HwCommand; [field: string]: unknown }

/** One reply line: `{ ok: true, … }` or `{ ok: false, code, message }`. */
export type HwReply = Record<string, unknown>;

/** Platform effects of the files feature (background window only). */
export interface HeartwoodPort {
  /**
   * Starts (or keeps) the daemon with the sync root chosen by
   * CogniFly; rejects with a code string.
   */
  start(serverUrl: string, wsUrl: string, org: string, root: string): Promise<HwInfo>;
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
/** One conflict copy on disk. */
export interface HwConflictCopy { copyPath: string; at: string }
/**
 * Conflicts of one file: the newest one's copy (`''` when none is on
 * disk), time and message, how many there were and the copies.
 */
export interface HwConflict {
  space: string;
  path: string;
  copyPath: string;
  at: string;
  message: string;
  count: number;
  /** Copies on disk, newest first. */
  copies: HwConflictCopy[];
}
/** One new local file the daemon does not send (no lock / no topic). */
export interface HwUntracked { space: string; path: string; folder: boolean; reason: string; reasonText: string }
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
  untracked: HwUntracked[];
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

/** One lock of a task's work (`work-files`, contract 3.5 and 9). */
export interface HwWorkLock {
  space: string;
  path: string;
  /** The lock covers a folder (everything below it). */
  folder: boolean;
  by: string;
  at: string;
  workId: string;
  writer: string | null;
  /** Absolute local path, `null` when not mirrored here. */
  localPath: string | null;
}

/** One version saved under a task's work. */
export interface HwWorkVersion {
  space: string;
  path: string;
  seq: number;
  author: string;
  at: string;
  kind: HwVersion['kind'];
  fromPath?: string;
  localPath: string | null;
}

/** The `work-files` answer (`WorkFilesResponse` + `localPath`). */
export interface HwWorkFiles {
  writer: string | null;
  closed: boolean;
  locks: HwWorkLock[];
  hiddenLocks: number;
  versions: HwWorkVersion[];
  cursor?: string;
}

/** Lock state of a browsed entry. */
export type HwEntryState = 'free' | 'writable' | 'locked' | 'local_changed' | 'conflict' | 'untracked';

/** One entry of a browsed folder level (`files`). */
export interface HwBrowseEntry {
  path: string;
  localPath: string | null;
  folder: boolean;
  size?: number;
  state: HwEntryState;
  workId?: string;
  writer?: string;
  /** The deciding lock is a folder lock. */
  lockFolder?: boolean;
}

/** The `files` answer: one level of a space folder. */
export interface HwBrowse {
  space: string;
  /** Folder in its stored spelling, `''` for the root. */
  folder: string;
  /** The space (or a part of it) is selected here. */
  selected: boolean;
  entries: HwBrowseEntry[];
}

/** Counts shown next to the clock. */
export interface FileCounts { conflicts: number; unsent: number }

/** The files part of the view. */
export interface FilesView { info: HwInfo; status: HwStatus | null; counts: FileCounts }

/** Info used before the supervisor answered. */
export const DISABLED_INFO: Readonly<HwInfo> = Object.freeze({ state: 'disabled', root: '', restarts: 0, lastError: null });

const CODE = /^[A-Z][A-Z_]{0,39}$/;
/** Longest daemon text sent to a window (characters). */
export const MAX_REFUSAL_TEXT = 300;
const VERSION_KINDS: readonly string[] = ['put', 'restore', 'move', 'delete'];
const ENTRY_STATES: readonly string[] = ['free', 'writable', 'locked', 'local_changed', 'conflict', 'untracked'];

/** Polish texts of app-side codes; daemon refusals bring their own. */
const MESSAGES: Readonly<Record<string, string>> = {
  NOT_RUNNING: 'Heartwood nie działa — uruchamiam ponownie…',
  NOT_INSTALLED: 'Heartwood nie jest zainstalowany na tym komputerze.',
  BAD_ROOT: 'Najpierw wybierz folder pracy w Ustawieniach.',
  ROOT_TOO_LONG: 'Ścieżka folderu pracy jest za długa dla plików Heartwood — wybierz krótszą.',
  DISABLED: 'Pliki nie są jeszcze włączone w tej wersji CogniFly.',
  TIMEOUT: 'Heartwood nie odpowiada.',
  OUTSIDE: 'Można wybrać tylko pliki z folderu Heartwood.',
  NOT_LOCAL: 'Tej przestrzeni nie ma na tym komputerze.',
  OPEN_FAILED: 'Nie udało się pokazać folderu w Finderze.',
  TASK_NOT_LOCKABLE: 'Do tego zadania nie można teraz dołączyć plików.',
  NOT_COPY: 'To nie jest kopia konfliktu.',
};

/**
 * Reads the `status` reply.
 *
 * Call: `parseStatus(reply)`.
 * Expects: anything (untrusted JSON from the daemon).
 * Output: the status with `null` optional texts dropped and bad
 * conflict, copy and untracked rows dropped one by one, or `null`
 * when the reply is a refusal, the top or another list is malformed.
 */
export function parseStatus(v: unknown): HwStatus | null {
  const o = record(v);
  if (!o || o.ok === false || typeof o.running !== 'boolean' || typeof o.connected !== 'boolean') return null;
  const spaces = list(o.spaces, parseSpace);
  const pending = list(o.pending, (x) => texts(x, ['space', 'op', 'path', 'status'], ['toPath', 'message']) as HwPending | null);
  const conflicts = Array.isArray(o.conflicts) ? rows(o.conflicts, parseConflict) : null;
  const skipped = list(o.skipped, (x) => texts(x, ['space', 'path', 'reason', 'reasonText'], ['suggestion', 'hint']) as HwSkipped | null);
  const untracked = o.untracked === undefined ? [] : Array.isArray(o.untracked) ? rows(o.untracked, parseUntracked) : null;
  const issues = list(o.issues, (x) => texts(x, ['space', 'message']) as HwIssue | null);
  if (!spaces || !pending || !conflicts || !skipped || !untracked || !issues) return null;
  return { running: o.running, connected: o.connected, spaces, pending, conflicts, skipped, untracked, issues };
}

/**
 * Reads one conflict row (one file).
 *
 * Call: `parseConflict(row)` via `rows`.
 * Expects: anything; an older daemon sends no `count`/`copies`,
 * then the row counts as one conflict with its `copyPath` (if any).
 * Output: the row with bad copies dropped, or `null` when a field
 * is missing or mistyped (`copies` not a list included).
 */
function parseConflict(v: unknown): HwConflict | null {
  const t = texts(v, ['space', 'path', 'copyPath', 'at', 'message']);
  const o = record(v);
  if (!t || !o) return null;
  if (o.count !== undefined && !isCount(o.count)) return null;
  if (o.copies !== undefined && !Array.isArray(o.copies)) return null;
  const copies = o.copies === undefined ? (t.copyPath ? [{ copyPath: t.copyPath, at: t.at! }] : []) : rows(o.copies, parseCopy);
  const count = (o.count as number | undefined) ?? 1;
  return { space: t.space!, path: t.path!, copyPath: t.copyPath!, at: t.at!, message: t.message!, count, copies };
}

/**
 * Reads one conflict copy.
 *
 * Call: `parseCopy(item)` via `rows`.
 * Expects: anything.
 * Output: `{ copyPath, at }`, or `null` when malformed.
 */
function parseCopy(v: unknown): HwConflictCopy | null {
  const t = texts(v, ['copyPath', 'at']);
  return t ? { copyPath: t.copyPath!, at: t.at! } : null;
}

/**
 * Reads one untracked file row.
 *
 * Call: `parseUntracked(row)` via `rows`.
 * Expects: anything.
 * Output: the row, or `null` when a field is missing or mistyped.
 */
function parseUntracked(v: unknown): HwUntracked | null {
  const t = texts(v, ['space', 'path', 'reason', 'reasonText']);
  const o = record(v);
  if (!t || !o || typeof o.folder !== 'boolean') return null;
  return { space: t.space!, path: t.path!, folder: o.folder, reason: t.reason!, reasonText: t.reasonText! };
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
  return Array.isArray(v) ? rows(v, parseVersion) : [];
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
 * Reads the `work-files` reply.
 *
 * Call: `parseWorkFiles(reply)`.
 * Expects: anything (untrusted JSON from the daemon).
 * Output: the work's files with malformed lock and version rows
 * dropped one by one, or `null` for a refusal or a malformed top.
 */
export function parseWorkFiles(v: unknown): HwWorkFiles | null {
  const o = record(v);
  if (!o || o.ok === false || !isTextOrNull(o.writer) || typeof o.closed !== 'boolean') return null;
  if (!isCount(o.hiddenLocks) || !Array.isArray(o.locks) || !Array.isArray(o.versions)) return null;
  if (o.cursor !== undefined && o.cursor !== null && typeof o.cursor !== 'string') return null;
  const cursor = typeof o.cursor === 'string' ? { cursor: o.cursor } : {};
  const locks = rows(o.locks, parseWorkLock);
  const versions = rows(o.versions, parseWorkVersion);
  return { writer: o.writer, closed: o.closed, locks, hiddenLocks: o.hiddenLocks, versions, ...cursor };
}

/**
 * Reads one lock of a work.
 *
 * Call: `parseWorkLock(row)` via `rows`.
 * Expects: anything; `writer` and `localPath` missing count as null.
 * Output: the lock, or `null` when a field is missing or mistyped.
 */
function parseWorkLock(v: unknown): HwWorkLock | null {
  const t = texts(v, ['space', 'path', 'by', 'at', 'workId'], ['writer', 'localPath']);
  const o = record(v);
  if (!t || !o || typeof o.folder !== 'boolean') return null;
  return {
    space: t.space!, path: t.path!, folder: o.folder, by: t.by!, at: t.at!, workId: t.workId!,
    writer: t.writer ?? null, localPath: t.localPath ?? null,
  };
}

/**
 * Reads one version saved under a work.
 *
 * Call: `parseWorkVersion(row)` via `rows`.
 * Expects: anything.
 * Output: the version (only the fields the app uses), or `null`
 * when malformed.
 */
function parseWorkVersion(v: unknown): HwWorkVersion | null {
  const t = texts(v, ['space', 'path', 'author', 'at', 'kind'], ['fromPath', 'localPath']);
  const o = record(v);
  if (!t || !o || !VERSION_KINDS.includes(t.kind!) || !isCount(o.seq)) return null;
  const from = t.fromPath !== undefined ? { fromPath: t.fromPath } : {};
  return {
    space: t.space!, path: t.path!, seq: o.seq, author: t.author!, at: t.at!,
    kind: t.kind as HwVersion['kind'], ...from, localPath: t.localPath ?? null,
  };
}

/**
 * Reads the `files` reply (one folder level).
 *
 * Call: `parseBrowse(reply)`.
 * Expects: anything (untrusted JSON from the daemon).
 * Output: the level with malformed entries dropped one by one, or
 * `null` for a refusal or a malformed top.
 */
export function parseBrowse(v: unknown): HwBrowse | null {
  const t = texts(v, ['space', 'folder']);
  const o = record(v);
  if (!t || !o || o.ok === false || typeof o.selected !== 'boolean' || !Array.isArray(o.entries)) return null;
  return { space: t.space!, folder: t.folder!, selected: o.selected, entries: rows(o.entries, parseEntry) };
}

/**
 * Reads one entry of a folder level.
 *
 * Call: `parseEntry(row)` via `rows`.
 * Expects: anything; a missing `localPath` counts as null.
 * Output: the entry with only present optional fields, or `null`
 * when malformed.
 */
function parseEntry(v: unknown): HwBrowseEntry | null {
  const t = texts(v, ['path', 'state'], ['localPath', 'workId', 'writer']);
  const o = record(v);
  if (!t || !o || typeof o.folder !== 'boolean' || !ENTRY_STATES.includes(t.state!)) return null;
  if (o.size !== undefined && !isCount(o.size)) return null;
  if (o.lockFolder !== undefined && typeof o.lockFolder !== 'boolean') return null;
  const e: HwBrowseEntry = { path: t.path!, localPath: t.localPath ?? null, folder: o.folder, state: t.state as HwEntryState };
  if (o.size !== undefined) e.size = o.size;
  if (t.workId !== undefined) e.workId = t.workId;
  if (t.writer !== undefined) e.writer = t.writer;
  if (o.lockFolder !== undefined) e.lockFolder = o.lockFolder;
  return e;
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
 * Parses the items of an array, dropping bad ones.
 *
 * Call: `rows(array, parseItem)`.
 * Expects: an array.
 * Output: the items `parse` accepted, order kept.
 */
function rows<T>(v: unknown[], parse: (item: unknown) => T | null): T[] {
  return v.map(parse).filter((x): x is T => x !== null);
}

/**
 * Checks a string or `null`.
 *
 * Call: `isTextOrNull(v)`.
 * Expects: anything.
 * Output: true for strings and `null`.
 */
function isTextOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
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
 * Checks a path inside a space before it reaches the daemon.
 *
 * Call: `isSpacePath(path)`; `isSpacePath(path, true)` for `history`
 * and folder levels.
 * Expects: any string.
 * Output: true for a relative path of non-empty segments other than
 * `.`/`..` without control characters; with `folderOk` also `''`
 * (the space root) and one trailing `/`. The daemon checks the
 * remaining name rules.
 */
export function isSpacePath(path: string, folderOk = false): boolean {
  if (folderOk && path === '') return true;
  const body = folderOk && path.endsWith('/') ? path.slice(0, -1) : path;
  if (body === '' || /[\p{Cc}]/u.test(body)) return false;
  return body.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Groups the locks of a work by space.
 *
 * Call: `locksBySpace(workFiles.locks)`.
 * Expects: parsed locks.
 * Output: one `{ space, paths }` per space in order of first
 * appearance, so each `release` stays within one space.
 */
export function locksBySpace(locks: readonly HwWorkLock[]): { space: string; paths: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const l of locks) groups.set(l.space, [...(groups.get(l.space) ?? []), l.path]);
  return [...groups].map(([space, paths]) => ({ space, paths }));
}

/** Most paths one lock or release request may carry (contract 3.3). */
export const MAX_PATHS_PER_REQUEST = 98;

/**
 * Splits a list into request-sized batches.
 *
 * Call: `inBatches(paths)`.
 * Expects: any list.
 * Output: consecutive slices of at most `MAX_PATHS_PER_REQUEST`.
 */
export function inBatches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PATHS_PER_REQUEST) out.push(items.slice(i, i + MAX_PATHS_PER_REQUEST));
  return out;
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
 * Throws: `RefusalError(code, text)` for a refusal; `text` is the
 * daemon's message on one line, at most `MAX_REFUSAL_TEXT` chars.
 * A missing or odd code becomes `BAD_RESPONSE` without text.
 */
export function checkReply(reply: HwReply): void {
  if (reply.ok === true) return;
  if (typeof reply.code !== 'string' || !CODE.test(reply.code)) throw new RefusalError('BAD_RESPONSE', undefined);
  const text = typeof reply.message === 'string' ? Array.from(oneLine(reply.message)).slice(0, MAX_REFUSAL_TEXT).join('') : '';
  throw new RefusalError(reply.code, text || undefined);
}

/** Name of the Heartwood folder inside the work folder. */
export const FILES_FOLDER = 'Pliki';

/**
 * Sync root of Heartwood chosen by CogniFly.
 *
 * Call: `heartwoodRoot('/Users/m/Praca')`.
 * Expects: the work folder from the settings (`''` = not chosen).
 * Output: `<work folder>/Pliki` (trailing `/` dropped), or `''`
 * when no work folder is set yet.
 */
export function heartwoodRoot(workFolder: string): string {
  const base = workFolder.replace(/\/+$/, '');
  return base ? `${base}/${FILES_FOLDER}` : '';
}

/**
 * Local path inside a space folder.
 *
 * Call: `inSpaceFolder(space.folder, path)`; `path` `''` gives the
 * folder's prefix (`<folder>/`).
 * Expects: a space folder from `status` (a trailing `/` allowed).
 * Output: `<folder>/<path>` with one `/` between them.
 */
export function inSpaceFolder(folder: string, path: string): string {
  return `${folder.replace(/\/+$/, '')}/${path}`;
}

/** Topic holding the task folders in a space. */
export const TASKS_TOPIC = 'Zadania';

/** Windows device names Heartwood refuses as a name's first part. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Longest description part of a task folder name (code points). */
const TASK_NAME_MAX = 60;

/** Name folders reserved by the client for conflict copies. */
const COPY_FOLDERS: readonly string[] = ['kopie konfliktów', '.heartwood-kopie'];

/**
 * Folder name of a task inside `Zadania`.
 *
 * Call: `taskFolderName(task)`.
 * Expects: a task with a checked id; any description.
 * Output: the description in NFC without `/\:*?"<>|` and control
 * characters, spaces collapsed, leading `.`/`~`/`$` dropped (hidden
 * or ignored names), cut to 60 code points without a trailing space,
 * then ` (<id>)`; only `(<id>)` when nothing is left.
 */
export function taskFolderName(task: { id: string; opis: string }): string {
  const clean = task.opis.normalize('NFC').replace(/[/\\:*?"<>|\p{Cc}]/gu, (c) => (/\s/.test(c) ? ' ' : ''));
  const flat = clean.replace(/\s+/g, ' ').replace(/^[\s.~$]+/, '');
  const head = cutName(escapeReserved(cutName(flat)));
  return head ? `${head} (${task.id})` : `(${task.id})`;
}

/**
 * Cuts a task folder description.
 *
 * Call: `cutName(text)`.
 * Expects: a cleaned description.
 * Output: at most 60 code points, no trailing whitespace.
 */
function cutName(text: string): string {
  return Array.from(text).slice(0, TASK_NAME_MAX).join('').trimEnd();
}

/**
 * Keeps a name off Windows device names (Heartwood `RESERVED_NAME`).
 *
 * Call: `escapeReserved(head)`.
 * Expects: a cut description.
 * Output: `_` + the text when its part before the first `.` is
 * con, prn, aux, nul, com1–9 or lpt1–9 (any case), else as is.
 * Only that part counts, so it is checked before ` (<id>)` is added
 * and `aux` alone stays (it becomes `aux (zad_…)`).
 */
function escapeReserved(head: string): string {
  if (!head.includes('.')) return head;
  return RESERVED.test(head.split('.')[0]!.toLowerCase()) ? `_${head}` : head;
}

/**
 * Finds the task's folder already in `Zadania`.
 *
 * Call: `existingTaskFolder(level, taskId)`.
 * Expects: the parsed `files` level of `Zadania`; a checked id.
 * Output: the name of the first folder ending with `(<id>)`
 * (alone or after a space), or `null`.
 */
export function existingTaskFolder(level: HwBrowse, taskId: string): string | null {
  for (const e of level.entries) {
    const name = e.path.split('/').pop() ?? '';
    if (e.folder && (name === `(${taskId})` || name.endsWith(` (${taskId})`))) return name;
  }
  return null;
}

/**
 * Checks a conflict copy path before it is revealed or resolved.
 *
 * Call: `isConflictCopy(path, root)`.
 * Expects: any string; the Heartwood root.
 * Output: true for a path under the root (`isUnderRoot`) with a
 * `Kopie konfliktów` (case-insensitive, NFC) or `.heartwood-kopie`
 * folder above its last segment.
 */
export function isConflictCopy(path: string, root: string): boolean {
  if (!isUnderRoot(path, root)) return false;
  const base = root.replace(/\/+$/, '');
  const folders = path.slice(base.length + 1).split('/').slice(0, -1);
  return folders.some((f) => COPY_FOLDERS.includes(f.normalize('NFC').toLocaleLowerCase('und')));
}

/** The `adopt` answer the windows get. */
export interface HwAdopted { folder: string; moved: { from: string; to: string }[] }

/**
 * Reads the `adopt` reply.
 *
 * Call: `parseAdopt(reply)`.
 * Expects: anything (untrusted JSON from the daemon).
 * Output: the task folder and the moved files (bad rows dropped),
 * or `null` for a malformed reply.
 */
export function parseAdopt(v: unknown): HwAdopted | null {
  const o = record(v);
  if (!o || typeof o.folder !== 'string' || !Array.isArray(o.moved)) return null;
  const moved = rows(o.moved, (m) => texts(m, ['from', 'to']) as { from: string; to: string } | null);
  return { folder: o.folder, moved };
}
