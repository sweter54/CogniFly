// What the "Pliki" screen and the task file buttons show: pure view
// model built from the files part of the view. Paths, names and
// reasons from the daemon are data; the UI sets them via textContent.
import { TASK_ID_PATTERN, type Task } from '@cognifly/wspolne/api';
import {
  hwMessage, type FilesView, type HwBrowse, type HwBrowseEntry, type HwConflict, type HwEntryState, type HwInfo, type HwIssue,
  type HwSkipped, type HwState, type HwVersion, type HwWorkFiles, type HwWorkLock, type HwWorkVersion,
} from './heartwood.js';
import { RpcError } from './rpc.js';

/** One selected space as a row of the screen. */
export interface SpaceRow {
  /** Space id (also what `files.unselect` takes). */
  label: string;
  folder: string;
  /** The local copy has every change the server has. */
  synced: boolean;
  unsent: number;
}

/** Everything the "Pliki" screen draws. */
export interface FilesModel {
  /** Why files do not work fully now, or `null`. */
  banner: string | null;
  /** A status is known (the lists and actions make sense). */
  ready: boolean;
  spaces: SpaceRow[];
  conflicts: HwConflict[];
  skipped: HwSkipped[];
  issues: HwIssue[];
}

/** One lock row of "Pliki zadania". */
export interface LockRow {
  /** `<ws>/<path>`, or `<ws>/<path>/ (folder)` for a folder lock. */
  label: string;
  who: string;
  when: string;
  space: string;
  path: string;
}

/** One changed file of "Pliki zadania" (its versions grouped). */
export interface ChangeRow {
  label: string;
  latestSeq: number;
  /** Number of versions the task saved for this file. */
  count: number;
  /** Kind of the newest version in Polish. */
  kindText: string;
  who: string;
  when: string;
  space: string;
  path: string;
  /** Versions of the file, newest first. */
  versions: HwWorkVersion[];
}

/** What the "Pliki zadania" section under a task draws. */
export interface TaskFilesModel {
  /** Lock and release actions are offered (the writer only). */
  canEdit: boolean;
  locks: LockRow[];
  changes: ChangeRow[];
  /** Note about locks in topics the user cannot read, or `null`. */
  hiddenNote: string | null;
  closed: boolean;
}

/** An action offered at a browsed entry. */
export type TreeAction = 'lock' | 'requestRelease' | 'history' | 'open';

/** One entry of the space browser. */
export interface TreeRow {
  name: string;
  path: string;
  folder: boolean;
  stateText: string;
  /** The CogniFly task holding the lock, or `null`. */
  taskLink: { taskId: string; title: string } | null;
  actions: TreeAction[];
}

/** What the space browser draws for one folder level. */
export interface TreeModel {
  rows: TreeRow[];
  /** "Otwórz w Finderze" makes sense (the folder is local). */
  canOpenFolder: boolean;
}

/** A task the browser can link a lock to. */
export interface TaskRef { id: string; workId: string; title: string }

/** Supervisor states with their banner code (`hwMessage`). */
const STATE_CODES: Partial<Record<HwState, string>> = {
  disabled: 'DISABLED', not_installed: 'NOT_INSTALLED', restarting: 'NOT_RUNNING',
};

/** Banner when the daemon works but cannot reach the server. */
const OFFLINE = 'Brak połączenia z serwerem plików — zmiany czekają.';

/** Polish names of version kinds. */
const KIND_NAMES: Record<HwVersion['kind'], string> = {
  put: 'zapis', restore: 'przywrócenie', move: 'przeniesienie', delete: 'usunięcie',
};

/** Polish names of the newest change of a file. */
const CHANGE_NAMES: Record<HwVersion['kind'], string> = {
  put: 'zmiana', restore: 'przywrócenie', move: 'przeniesienie', delete: 'usunięcie',
};

/** Polish texts of entry states (`locked` adds the writer). */
const STATE_TEXTS: Record<HwEntryState, string> = {
  free: 'wolny', writable: 'moje zadanie', locked: 'zablokowany', local_changed: 'czeka na wysłanie', conflict: 'konflikt',
};

/** Shown after "zablokowany —" when the work has no writer. */
const NO_WRITER = 'nikt nie pisze';

/** Prefix of work ids that are CogniFly tasks. */
const TASK_WORK_PREFIX = 'cognifly:';

/** Task states in which the owner writes the files. */
const OWNER_STATES: readonly string[] = ['wziete', 'w_trakcie'];

/**
 * Builds the model of the "Pliki" screen.
 *
 * Call: `filesViewModel(view.files)` on every view change.
 * Expects: the files part of the view.
 * Output: banner, rows and lists; lists are empty without a status.
 */
export function filesViewModel(files: FilesView): FilesModel {
  const s = files.status;
  return {
    banner: bannerText(files.info, s !== null, s?.connected ?? false),
    ready: s !== null,
    spaces: (s?.spaces ?? []).map((sp) => ({
      label: sp.space, folder: sp.folder, synced: sp.serverSeq === null || sp.lastSeq === sp.serverSeq, unsent: sp.unsent,
    })),
    conflicts: s?.conflicts ?? [],
    skipped: s?.skipped ?? [],
    issues: s?.issues ?? [],
  };
}

/**
 * Banner text for the supervisor state and connection.
 *
 * Call: `bannerText(info, hasStatus, connected)`.
 * Expects: supervisor info; whether a status is known and online.
 * Output: the state's `hwMessage`, "no answer" for a running daemon
 * without status, the offline text, or `null` (also while starting).
 */
function bannerText(info: HwInfo, hasStatus: boolean, connected: boolean): string | null {
  const code = STATE_CODES[info.state];
  if (code) return hwMessage(code);
  if (info.state !== 'running') return null;
  if (!hasStatus) return hwMessage('TIMEOUT');
  return connected ? null : OFFLINE;
}

/**
 * Sync state of a space row.
 *
 * Call: `spaceStatusText(row)`.
 * Expects: a row of `filesViewModel`.
 * Output: "Wysyłanie: N" while changes wait to be sent, else
 * "Zsynchronizowane" or "Pobieranie zmian…".
 */
export function spaceStatusText(row: SpaceRow): string {
  if (row.unsent > 0) return `Wysyłanie: ${row.unsent}`;
  return row.synced ? 'Zsynchronizowane' : 'Pobieranie zmian…';
}

/**
 * Reads the optional topics field.
 *
 * Call: `parseTopics(input.value)`.
 * Expects: topics separated by commas.
 * Output: trimmed non-empty topics, or `undefined` for none.
 */
export function parseTopics(text: string): string[] | undefined {
  const topics = text.split(',').map((t) => t.trim()).filter((t) => t !== '');
  return topics.length ? topics : undefined;
}

/**
 * One line of the version history.
 *
 * Call: `versionLine(version)`.
 * Expects: a parsed version (also one of `work-files`).
 * Output: "Wersja N · <data> · <autor> · <rodzaj>" in Polish.
 */
export function versionLine(v: Pick<HwVersion, 'seq' | 'at' | 'author' | 'kind'>): string {
  return `Wersja ${v.seq} · ${whenText(v.at)} · ${v.author} · ${KIND_NAMES[v.kind]}`;
}

/**
 * A daemon time in Polish.
 *
 * Call: `whenText(record.at)`.
 * Expects: an ISO time (untrusted).
 * Output: local date and time, or the text as is when unreadable.
 */
function whenText(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString('pl-PL');
}

/**
 * Polish text for a failed file action.
 *
 * Call: `fileErrorText(e)` in catch blocks of file calls.
 * Expects: anything thrown by `call`.
 * Output: `hwMessage(code, detail)`; non-rpc errors are `UNEXPECTED`.
 */
export function fileErrorText(e: unknown): string {
  return e instanceof RpcError ? hwMessage(e.code, e.detail) : hwMessage('UNEXPECTED');
}

/**
 * Tells whether a task offers "Zablokuj pliki…".
 *
 * Call: `canLockFiles(task, me, view.files.info.state)`.
 * Expects: the user's person id (null when unknown).
 * Output: true for the owner of a taken / in-progress task and for
 * the acceptor of a task waiting for acceptance, while files can
 * work on this computer (not disabled or missing).
 */
export function canLockFiles(task: Task, me: string | null, state: HwState): boolean {
  if (me === null || state === 'disabled' || state === 'not_installed') return false;
  if (task.stan === 'do_akceptacji') return task.akceptujacy === me;
  return OWNER_STATES.includes(task.stan) && task.wlasciciel === me;
}

/**
 * Builds the "Pliki zadania" section of a task.
 *
 * Call: `taskFilesModel(files, me)` after `task.files`.
 * Expects: the work's files (`null` before an answer) and the
 * user's Heartwood `sub` (`null` when unknown).
 * Output: lock rows, changed files grouped per file and the hidden
 * locks note; actions only for the work's writer while open.
 */
export function taskFilesModel(w: HwWorkFiles | null, me: string | null): TaskFilesModel {
  if (!w) return { canEdit: false, locks: [], changes: [], hiddenNote: null, closed: false };
  return {
    canEdit: !!me && w.writer === me && !w.closed,
    locks: w.locks.map(lockRow),
    changes: groupVersions(w.versions).map(changeRow),
    hiddenNote: hiddenLocksNote(w.hiddenLocks),
    closed: w.closed,
  };
}

/**
 * One lock as a row.
 *
 * Call: `w.locks.map(lockRow)`.
 * Expects: a parsed lock.
 * Output: the row; a folder lock ends with `/ (folder)`.
 */
function lockRow(l: HwWorkLock): LockRow {
  const label = `${spacePath(l.space, l.path)}${l.folder ? '/ (folder)' : ''}`;
  return { label, who: l.by, when: whenText(l.at), space: l.space, path: l.path };
}

/**
 * Groups versions per file.
 *
 * Call: `groupVersions(w.versions)`.
 * Expects: versions in any order.
 * Output: one list per `space`+`path`, each newest first (`seq` is
 * per space), the lists in order of their first version.
 */
function groupVersions(versions: readonly HwWorkVersion[]): HwWorkVersion[][] {
  const groups = new Map<string, HwWorkVersion[]>();
  for (const v of versions) {
    const key = JSON.stringify([v.space, v.path]);
    const group = groups.get(key);
    if (group) group.push(v);
    else groups.set(key, [v]);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => b.seq - a.seq));
}

/**
 * One changed file as a row.
 *
 * Call: `groups.map(changeRow)`.
 * Expects: a non-empty group, newest first.
 * Output: the row described by its newest version.
 */
function changeRow(versions: HwWorkVersion[]): ChangeRow {
  const top = versions[0]!;
  return {
    label: spacePath(top.space, top.path), latestSeq: top.seq, count: versions.length, kindText: changeText(top),
    who: top.author, when: whenText(top.at), space: top.space, path: top.path, versions,
  };
}

/**
 * Polish name of a file's newest change.
 *
 * Call: `changeText(version)`.
 * Expects: a parsed version.
 * Output: e.g. "zmiana"; a move adds "z <fromPath>" when known.
 */
function changeText(v: HwWorkVersion): string {
  const name = CHANGE_NAMES[v.kind];
  return v.kind === 'move' && v.fromPath ? `${name} z ${v.fromPath}` : name;
}

/**
 * A path with its space for humans.
 *
 * Call: `spacePath('ws:w1', 'a/b.txt')`.
 * Expects: a space id and a path in it.
 * Output: `w1/a/b.txt`; private spaces show as `Prywatne/…`.
 */
function spacePath(space: string, path: string): string {
  return `${spaceName(space)}/${path}`;
}

/**
 * Folder name of a space id.
 *
 * Call: `spaceName('ws:w1')`.
 * Expects: a space id.
 * Output: the workspace name, "Prywatne" for `user:…`, else as is.
 */
function spaceName(space: string): string {
  if (space.startsWith('ws:')) return space.slice('ws:'.length);
  return space.startsWith('user:') ? 'Prywatne' : space;
}

/**
 * Note about locks the user cannot see.
 *
 * Call: `hiddenLocksNote(w.hiddenLocks)`.
 * Expects: a count ≥ 0.
 * Output: e.g. "3 blokady w tematach, do których nie masz
 * dostępu", or `null` for 0.
 */
function hiddenLocksNote(n: number): string | null {
  if (n <= 0) return null;
  return `${n} ${plural(n, 'blokada', 'blokady', 'blokad')} w tematach, do których nie masz dostępu`;
}

/**
 * Polish plural form for a count.
 *
 * Call: `plural(n, 'zapis', 'zapisy', 'zapisów')`.
 * Expects: an integer ≥ 0 and the three forms.
 * Output: `one` for 1, `few` for 2–4 (not 12–14) in the last
 * digits, else `many`.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/**
 * Builds the space browser for one folder level.
 *
 * Call: `treeViewModel(browse, myTasks)` after `files.tree`.
 * Expects: a parsed level and the user's tasks with work ids.
 * Output: rows with state, task link and actions; opening the
 * folder only when the space is selected and the level is local.
 */
export function treeViewModel(b: HwBrowse, myTasks: readonly TaskRef[]): TreeModel {
  const lockable = !b.space.startsWith('user:');
  return { rows: b.entries.map((e) => treeRow(e, myTasks, lockable)), canOpenFolder: isLocalLevel(b) };
}

/**
 * Tells whether a browsed level is on this computer.
 *
 * Call: `isLocalLevel(browse)`.
 * Expects: a parsed level; a partly selected space has `selected`
 * and `localPath: null` in unselected topics.
 * Output: true for a selected space whose level is empty or has
 * an entry with a local path.
 */
function isLocalLevel(b: HwBrowse): boolean {
  return b.selected && (b.entries.length === 0 || b.entries.some((e) => e.localPath !== null));
}

/**
 * One browsed entry as a row.
 *
 * Call: `treeRow(entry, myTasks, lockable)`.
 * Expects: a parsed entry; `lockable` false in private spaces.
 * Output: the row with its name (last path segment).
 */
function treeRow(e: HwBrowseEntry, myTasks: readonly TaskRef[], lockable: boolean): TreeRow {
  return {
    name: e.path.split('/').pop() ?? e.path, path: e.path, folder: e.folder, stateText: entryStateText(e),
    taskLink: taskLink(e.workId, myTasks), actions: entryActions(e, lockable),
  };
}

/**
 * Polish state of an entry.
 *
 * Call: `entryStateText(entry)`.
 * Expects: a parsed entry.
 * Output: e.g. "wolny"; a lock adds its writer or "nikt nie pisze".
 */
function entryStateText(e: HwBrowseEntry): string {
  const text = STATE_TEXTS[e.state];
  return e.state === 'locked' ? `${text} — ${e.writer ?? NO_WRITER}` : text;
}

/**
 * The CogniFly task of a lock.
 *
 * Call: `taskLink(entry.workId, myTasks)`.
 * Expects: a work id (may be missing) and the user's tasks.
 * Output: the task id with its title (the id when not among the
 * user's tasks) for `cognifly:<valid id>`, else `null`.
 */
function taskLink(workId: string | undefined, myTasks: readonly TaskRef[]): TreeRow['taskLink'] {
  if (!workId?.startsWith(TASK_WORK_PREFIX)) return null;
  const taskId = workId.slice(TASK_WORK_PREFIX.length);
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  return { taskId, title: myTasks.find((t) => t.workId === workId)?.title ?? taskId };
}

/**
 * Actions offered at an entry.
 *
 * Call: `entryActions(entry, lockable)`.
 * Expects: a parsed entry; `lockable` false in private spaces.
 * Output: lock (free) or request release (locked) where locks
 * exist, history for files, open for entries with a local path.
 */
function entryActions(e: HwBrowseEntry, lockable: boolean): TreeAction[] {
  const out: TreeAction[] = [];
  if (lockable && e.state === 'free') out.push('lock');
  if (lockable && e.state === 'locked') out.push('requestRelease');
  if (!e.folder) out.push('history');
  if (e.localPath !== null) out.push('open');
  return out;
}
