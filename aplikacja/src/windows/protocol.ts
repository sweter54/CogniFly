// Contract between UI windows and the background window: method names,
// window labels and pushed events. Shared by both sides.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { FilesView, HwAdopted, HwBrowse, HwVersion, HwWorkFiles } from '../logic/heartwood.js';

/** Window labels (must match tauri.conf.json and capabilities). */
export const WINDOWS = { background: 'background', main: 'main' } as const;

/** Screens of the main window. */
export type Screen = 'login' | 'inbox' | 'files' | 'settings';

/** Event pushed to the main window after every view change. */
export const INBOX_EVENT = 'cognifly://inbox';
/** Event asking the main window to switch screen. */
export const SCREEN_EVENT = 'cognifly://screen';

/** Snapshot of the session and inbox shown by the main window. */
export interface InboxView {
  loggedIn: boolean;
  offline: boolean;
  email: string | null;
  /** The person's id in the current company (from `GET /ja`). */
  osoba: string | null;
  tasks: Task[];
  /** ISO time of the last successful poll, or `null`. */
  updatedAt: string | null;
  /** Work folder for Claude; `''` means setup is not finished. */
  workFolder: string;
  /** Heartwood state, last status and counts (files screen, tray). */
  files: FilesView;
}

/** Methods served by the background window: params → result. */
export interface Methods {
  'account.get': {
    params: Record<string, never>;
    result: { email: string | null; osoba: string | null; company: string; companies: { firma: string; osoba: string }[] };
  };
  'config.setCompany': { params: { company: string }; result: { ok: true } };
  'login.sendCode': { params: { email: string }; result: { email: string } };
  'login.confirm': { params: { code: string }; result: { email: string } };
  'inbox.get': { params: Record<string, never>; result: InboxView };
  'inbox.refresh': { params: Record<string, never>; result: InboxView };
  'inbox.take': { params: { id: string }; result: { status: 'TAKEN' } | { status: 'BUSY'; owner: string } };
  'inbox.setState': { params: { id: string; state: UserSettableState; acceptor?: string }; result: { ok: true } };
  'task.accept': { params: { id: string }; result: { ok: true } };
  'task.sendBack': { params: { id: string; reason: string }; result: { ok: true } };
  'session.logout': { params: Record<string, never>; result: { ok: true } };
  'task.openInClaude': { params: { id: string; newThread?: boolean }; result: { ok: true } };
  'task.reject': { params: { id: string; reason: string }; result: { ok: true } };
  'task.remove': { params: { id: string }; result: { ok: true } };
  'task.handOver': { params: { id: string; person: string }; result: { ok: true } };
  'config.pickFolder': { params: { current: string }; result: { path: string | null } };
  'config.setWorkFolder': { params: { path: string }; result: { ok: true } };
  'people.list': { params: Record<string, never>; result: { people: { osoba: string; github?: string }[] } };
  'review.request': { params: { repo: string; pr: number; reviewers: string[] }; result: { taskId: string } };
  'files.get': { params: Record<string, never>; result: FilesView };
  'files.refresh': { params: Record<string, never>; result: FilesView };
  /** `path` is local, or in `space` when given (`''`/trailing `/` = folder). */
  'files.history': { params: { path: string; space?: string }; result: { versions: HwVersion[]; path: string } };
  /** `path` is local, or in `space` when given. */
  'files.download': { params: { path: string; space?: string; version: number }; result: { copy: string } };
  'files.restore': { params: { path: string; version: number }; result: { ok: true } };
  'files.select': { params: { space: string; topics?: string[] }; result: { ok: true } };
  'files.unselect': { params: { space: string; topics?: string[]; yes: boolean }; result: { ok: true } };
  'files.pickPath': { params: Record<string, never>; result: { path: string | null } };
  'task.lockFiles': { params: { id: string }; result: { paths: string[] } };
  /** With `space` + `path` one lock, else every visible lock. */
  'task.releaseFiles': { params: { id: string; space?: string; path?: string }; result: { paths: string[] } };
  /** Locks and versions of the task's work; `me` is the user's `sub`. */
  'task.files': { params: { id: string }; result: { id: string; files: HwWorkFiles; me: string | null } };
  /** One folder level of a space (`folder` omitted = root). */
  'files.tree': { params: { space: string; folder?: string }; result: HwBrowse };
  /** Locks a path in a space for a task (`folder` = a folder lock). */
  'files.lockFor': { params: { taskId: string; space: string; path: string; folder?: boolean }; result: { ok: true } };
  'files.requestRelease': { params: { space: string; path: string }; result: { ok: true } };
  /** Opens a folder of a selected space in Finder (`''` = its root). */
  'files.reveal': { params: { space: string; folder: string }; result: { ok: true } };
  /** Moves untracked local files (one `ws:` space) into a task's folder. */
  'files.adopt': { params: { paths: string[]; taskId: string }; result: HwAdopted };
  /** Clears one conflict copy, or every conflict of a file. */
  'files.resolve': { params: { copyPath: string } | { space: string; path: string }; result: { ok: true } };
  /** Shows a conflict copy (under the root, in `Kopie konfliktów`). */
  'files.revealCopy': { params: { copyPath: string }; result: { ok: true } };
  /** Shows a task in the inbox (like a `cognifly://` link). */
  'task.focus': { params: { id: string }; result: { ok: true } };
}
export type Method = keyof Methods;
