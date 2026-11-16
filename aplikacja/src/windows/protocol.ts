// Contract between UI windows and the background window: method names,
// window labels and pushed events. Shared by both sides.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { AppConfig } from '../logic/config.js';

/** Window labels (must match tauri.conf.json and capabilities). */
export const WINDOWS = { background: 'background', settings: 'settings', login: 'login', inbox: 'inbox' } as const;
export type UiWindow = Exclude<(typeof WINDOWS)[keyof typeof WINDOWS], 'background'>;

/** Event pushed to the inbox window after every poll. */
export const INBOX_EVENT = 'cognifly://inbox';

/** Snapshot of what the inbox window shows. */
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
}
export type Method = keyof Methods;
