// What to notify about and what the tray shows. Only the server-built
// `opis` ever reaches a notification (other task text is data).
import { WAITING_STATES, type Task } from '@cognifly/wspolne/api';
import { readJson, writeJson, type KeyValueStore } from './storage.js';

/** Maximum notification body length (characters). */
export const MAX_BODY_CHARS = 200;
const SEEN_KEY = 'cognifly.seen';

/**
 * Filters tasks that wait for someone to take them.
 *
 * Call: `waitingTasks(tasks)`.
 * Expects: tasks from `/skrzynka`.
 * Output: tasks in state `nowe` or `eskalowane`, in input order.
 */
export function waitingTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => (WAITING_STATES as readonly string[]).includes(t.stan));
}

/**
 * Deduplication key: the same task notifies again when it escalates.
 *
 * Call: `seenKey(task)`.
 * Expects: a task.
 * Output: `<id>#<stan>`.
 */
export function seenKey(task: Task): string {
  return `${task.id}#${task.stan}`;
}

/**
 * Picks tasks that deserve a notification.
 *
 * Call: `pickNew(tasks, seen)`; `seen` is `null` on the first run.
 * Expects: the full current inbox.
 * Output: `fresh` = waiting tasks whose key was not seen (always empty
 * on the first run, which only records); `seen` = keys of all
 * currently waiting tasks (old keys are dropped, so it stays small).
 */
export function pickNew(tasks: readonly Task[], seen: ReadonlySet<string> | null): { fresh: Task[]; seen: Set<string> } {
  const waiting = waitingTasks(tasks);
  const fresh = seen === null ? [] : waiting.filter((t) => !seen.has(seenKey(t)));
  return { fresh, seen: new Set(waiting.map(seenKey)) };
}

/**
 * Notification title for a task.
 *
 * Call: `notificationTitle(task)`.
 * Expects: a waiting task.
 * Output: Polish title; escalations are marked.
 */
export function notificationTitle(task: Task): string {
  return task.stan === 'eskalowane' ? 'CogniFly — eskalacja' : 'CogniFly — nowe zadanie';
}

/**
 * Makes `opis` safe to show as a one-line notification body.
 *
 * Call: `notificationBody(opis)`.
 * Expects: the server-built description (any string).
 * Output: control characters and line breaks collapsed to single
 * spaces, trimmed, at most `MAX_BODY_CHARS` characters (ends with
 * `…` when cut); a generic text when nothing is left.
 */
export function notificationBody(opis: string): string {
  const clean = opis.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  if (!clean) return 'Masz nowe zadanie.';
  const chars = Array.from(clean);
  if (chars.length <= MAX_BODY_CHARS) return clean;
  return `${chars.slice(0, MAX_BODY_CHARS - 1).join('').trimEnd()}…`;
}

/** What the tray title reflects. */
export interface TrayState { loggedIn: boolean; offline: boolean; waiting: number }

/**
 * Text shown next to the menu-bar icon.
 *
 * Call: `trayTitle(state)`.
 * Expects: the latest poll state.
 * Output: `''` when logged out or nothing waits, `'!'` when offline
 * with nothing known, otherwise the count (`99+` above 99).
 */
export function trayTitle(state: TrayState): string {
  if (!state.loggedIn) return '';
  if (state.offline && state.waiting === 0) return '!';
  if (state.waiting === 0) return '';
  return state.waiting > 99 ? '99+' : String(state.waiting);
}

/**
 * Loads the seen-key set.
 *
 * Call: `loadSeen(store)`.
 * Expects: any store.
 * Output: the saved set, or `null` when nothing was saved yet
 * (meaning: first run, do not notify).
 */
export function loadSeen(store: KeyValueStore): Set<string> | null {
  const raw = readJson(store, SEEN_KEY);
  return Array.isArray(raw) ? new Set(raw.filter((k): k is string => typeof k === 'string')) : null;
}

/**
 * Saves the seen-key set.
 *
 * Call: `saveSeen(store, seen)`.
 * Expects: the set returned by `pickNew`.
 * Output: none.
 */
export function saveSeen(store: KeyValueStore, seen: ReadonlySet<string>): void {
  writeJson(store, SEEN_KEY, [...seen]);
}

/**
 * Forgets seen keys (after logout, so the next user starts fresh).
 *
 * Call: `clearSeen(store)`.
 * Expects: any store.
 * Output: none.
 */
export function clearSeen(store: KeyValueStore): void {
  store.removeItem(SEEN_KEY);
}
