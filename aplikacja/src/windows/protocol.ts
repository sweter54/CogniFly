// Contract between UI windows and the background window: method names,
// window labels and pushed events. Shared by both sides.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { AppConfig } from '../logic/config.js';

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
  tasks: Task[];
  /** ISO time of the last successful poll, or `null`. */
  updatedAt: string | null;
}

/** Methods served by the background window: params → result. */
export interface Methods {
  'config.get': { params: Record<string, never>; result: { config: AppConfig; defaults: AppConfig } };
  'config.save': { params: { config: AppConfig }; result: { ok: true } | { ok: false; field: keyof AppConfig } };
  'login.sendCode': { params: { email: string }; result: { email: string } };
  'login.confirm': { params: { code: string }; result: { email: string } };
  'inbox.get': { params: Record<string, never>; result: InboxView };
  'inbox.refresh': { params: Record<string, never>; result: InboxView };
  'inbox.take': { params: { id: string }; result: { status: 'TAKEN' } | { status: 'BUSY'; owner: string } };
  'inbox.setState': { params: { id: string; state: UserSettableState }; result: { ok: true } };
  'session.logout': { params: Record<string, never>; result: { ok: true } };
  'task.openInClaude': { params: { id: string }; result: { ok: true } };
}
export type Method = keyof Methods;
