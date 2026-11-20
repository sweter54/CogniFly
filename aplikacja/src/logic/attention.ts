// "Do załatwienia" of the tray menu: a priority queue of what needs
// the user, rebuilt from every view. Pure; the tray only draws it.
import type { InboxView, Screen } from '../windows/protocol.js';
import { conflictKey, conflictRows, spaceName } from './files-view.js';
import { hwMessage } from './heartwood.js';
import { oneLine, waitingTasks } from './notify.js';
import { clip, shortPath } from './text.js';

/** Most queue items shown in the menu. */
export const MAX_ATTENTION_ITEMS = 5;
/** Longest path shown in a conflict item (characters). */
const PATH_CHARS = 40;
/** Longest task title or error shown in an item (characters). */
const TITLE_CHARS = 50;

/** What clicking an item does. */
export type AttentionAction =
  | { kind: 'refresh' }
  | { kind: 'main' }
  | { kind: 'screen'; screen: Screen; highlight?: string };

/** One thing that needs the user. */
export interface AttentionItem {
  /** Stable id of the thing (same item on the next render). */
  key: string;
  /** Polish menu text (plain; see `menuText` for the menu). */
  text: string;
  action: AttentionAction;
}

/** One line of the menu section. */
export interface AttentionEntry {
  text: string;
  /** `false` for the "all done" line. */
  enabled: boolean;
  /** `null` for a line that does nothing. */
  action: AttentionAction | null;
}

/**
 * Builds the queue of what needs the user, most urgent first.
 *
 * Call: `attentionQueue(view)` on every render.
 * Expects: a view.
 * Output: `[]` when logged out; else the "no access" item (work
 * stopped), one connection item (server or file server offline),
 * then file conflicts, spaces with unsent files, tasks waiting
 * for the user, and the last Heartwood error, each with its action.
 */
export function attentionQueue(view: InboxView): AttentionItem[] {
  if (!view.loggedIn) return [];
  return [...blockedItems(view), ...offlineItems(view), ...conflictItems(view), ...unsentItems(view), ...taskItems(view), ...errorItems(view)];
}

/**
 * The "no access" item.
 *
 * Call: `blockedItems(view)`.
 * Expects: a logged-in view.
 * Output: one refresh item with the reason (checks access again)
 * when work is stopped, else none.
 */
function blockedItems(view: InboxView): AttentionItem[] {
  return view.blocked ? [{ key: 'blocked', text: view.blocked, action: { kind: 'refresh' } }] : [];
}

/**
 * The connection item.
 *
 * Call: `offlineItems(view)`.
 * Expects: a logged-in view.
 * Output: one refresh item when the server or the running file
 * daemon is offline, else none.
 */
function offlineItems(view: InboxView): AttentionItem[] {
  const { info, status } = view.files;
  const filesOffline = info.state === 'running' && status !== null && !status.connected;
  if (!view.offline && !filesOffline) return [];
  return [{ key: 'offline', text: 'Brak połączenia z serwerem — kliknij, aby odświeżyć', action: { kind: 'refresh' } }];
}

/**
 * Items of conflicting files.
 *
 * Call: `conflictItems(view)`.
 * Expects: a logged-in view.
 * Output: one item per file, opening the files screen with that
 * conflict highlighted.
 */
function conflictItems(view: InboxView): AttentionItem[] {
  return conflictRows(view.files.status).map((c) => {
    const key = conflictKey(c.space, c.path);
    return { key: `conflict:${key}`, text: `⚠ Konflikt: ${shortPath(c.label, PATH_CHARS)}`, action: { kind: 'screen', screen: 'files', highlight: key } };
  });
}

/**
 * Items of spaces with files waiting to be sent.
 *
 * Call: `unsentItems(view)`.
 * Expects: a logged-in view.
 * Output: one item per space with `unsent > 0`, opening the files
 * screen.
 */
function unsentItems(view: InboxView): AttentionItem[] {
  return (view.files.status?.spaces ?? []).filter((s) => s.unsent > 0).map((s) => ({
    key: `unsent:${s.space}`, text: `↑ Do wysłania: ${spaceName(s.space)} (${s.unsent})`, action: { kind: 'screen', screen: 'files' },
  }));
}

/**
 * Items of tasks waiting for the user.
 *
 * Call: `taskItems(view)`.
 * Expects: a logged-in view.
 * Output: one item per waiting task (its server-built `opis`, one
 * line, shortened), opening the inbox with the task highlighted.
 */
function taskItems(view: InboxView): AttentionItem[] {
  return waitingTasks(view.tasks, view.osoba).map((t) => ({
    key: `task:${t.id}`, text: `📥 ${clip(oneLine(t.opis) || t.id, TITLE_CHARS)}`, action: { kind: 'screen', screen: 'inbox', highlight: t.id },
  }));
}

/**
 * The item of the last Heartwood error.
 *
 * Call: `errorItems(view)`.
 * Expects: a logged-in view.
 * Output: one item opening the files screen when the supervisor
 * reports a last error (a code gets its Polish text), else none.
 */
function errorItems(view: InboxView): AttentionItem[] {
  const error = view.files.info.lastError;
  if (!error) return [];
  const text = clip(oneLine(hwMessage(error, error)), TITLE_CHARS);
  return [{ key: 'hw-error', text: `Pliki: ${text}`, action: { kind: 'screen', screen: 'files' } }];
}

/**
 * Lines of the menu section for a queue.
 *
 * Call: `attentionEntries(attentionQueue(view), view.loggedIn)`.
 * Expects: a queue, most urgent first.
 * Output: at most `MAX_ATTENTION_ITEMS` items, plus `…i jeszcze N`
 * (opens the main window) when more exist; for an empty queue one
 * disabled line: "Wszystko załatwione", or a login hint when
 * logged out. Texts are ready for the menu (`menuText`).
 */
export function attentionEntries(queue: readonly AttentionItem[], loggedIn: boolean): AttentionEntry[] {
  if (!queue.length) return [{ text: loggedIn ? 'Wszystko załatwione' : 'Zaloguj się, aby zobaczyć sprawy', enabled: false, action: null }];
  const shown = queue.slice(0, MAX_ATTENTION_ITEMS).map((i) => ({ text: menuText(i.text), enabled: true, action: i.action }));
  const more = queue.length - shown.length;
  return more > 0 ? [...shown, { text: `…i jeszcze ${more}`, enabled: true, action: { kind: 'main' } }] : shown;
}

/**
 * Escapes text for a native menu item.
 *
 * Call: `menuText(text)` before `MenuItem.setText`.
 * Expects: plain text.
 * Output: the text with `&` doubled: menus treat a single `&` as
 * a mnemonic mark and drop it.
 */
export function menuText(text: string): string {
  return text.replace(/&/g, '&&');
}
