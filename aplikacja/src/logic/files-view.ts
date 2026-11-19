// What the "Pliki" screen and the task file buttons show: pure view
// model built from the files part of the view. Paths, names and
// reasons from the daemon are data; the UI sets them via textContent.
import type { Task } from '@cognifly/wspolne/api';
import { hwMessage, type FilesView, type HwConflict, type HwInfo, type HwIssue, type HwSkipped, type HwState, type HwVersion } from './heartwood.js';
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
 * Expects: a parsed version record.
 * Output: "Wersja N · <data> · <autor> · <rodzaj>" in Polish.
 */
export function versionLine(v: HwVersion): string {
  const at = new Date(v.at);
  const when = Number.isNaN(at.getTime()) ? v.at : at.toLocaleString('pl-PL');
  return `Wersja ${v.seq} · ${when} · ${v.author} · ${KIND_NAMES[v.kind]}`;
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
