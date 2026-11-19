// Contract between UI windows and the background window: method names,
// window labels and pushed events. Shared by both sides.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { FilesView, HwVersion } from '../logic/heartwood.js';

/** Window labels (must match tauri.conf.json and capabilities). */
export const WINDOWS = { background: 'background', main: 'main' } as const;

/** Screens of the main window. */
export type Screen = 'login' | 'inbox' | 'settings';

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
  'files.history': { params: { path: string }; result: { versions: HwVersion[]; path: string } };
  'files.download': { params: { path: string; version: number }; result: { copy: string } };
  'files.restore': { params: { path: string; version: number }; result: { ok: true } };
  'files.select': { params: { space: string; topics?: string[] }; result: { ok: true } };
  'files.unselect': { params: { space: string; topics?: string[]; yes: boolean }; result: { ok: true } };
  'files.pickPath': { params: Record<string, never>; result: { path: string | null } };
  'task.lockFiles': { params: { id: string }; result: { paths: string[] } };
  'task.releaseFiles': { params: { id: string }; result: { paths: string[] } };
  'task.lockedFiles': { params: { id: string }; result: { paths: string[] } };
}
export type Method = keyof Methods;
