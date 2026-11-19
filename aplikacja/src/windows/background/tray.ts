// Menu-bar icon: count next to the icon, a spelled-out tooltip and a
// small menu with the "Do załatwienia" queue. Rendering only; actions
// are passed in by the background window.
import { defaultWindowIcon } from '@tauri-apps/api/app';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { TrayIcon, type TrayIconEvent } from '@tauri-apps/api/tray';
import { attentionEntries, attentionQueue, menuText, type AttentionAction, type AttentionEntry } from '../../logic/attention.js';
import { waitingCount } from '../../logic/controller.js';
import { trayTitle, trayTooltip, type TrayState } from '../../logic/notify.js';
import type { InboxView, Screen } from '../protocol.js';

/** Actions triggered from the icon and its menu. */
export interface TrayActions {
  /** Left click on the icon (the menu opens on right click). */
  openMain(): void;
  openInbox(): void;
  /** Opens a screen, optionally highlighting a task or conflict. */
  show(screen: Screen, highlight?: string): void;
  refresh(): void;
  openSettings(): void;
  login(): void;
  logout(): void;
}

/** Id of the single tray icon of the app. */
const TRAY_ID = 'cognifly';
/** Menu position of the first queue line (after status, line, title). */
const QUEUE_START = 3;

/** Handle to update the tray after each view change. */
export interface Tray { render(view: InboxView): Promise<void> }

/**
 * Creates the tray icon and its menu.
 *
 * Call: `await createTray(actions)` once in the background window.
 * Expects: `core:tray`, `core:menu` and default-icon permissions.
 * Output: a `Tray`: left click opens the main window, right click
 * shows the menu; its `render(view)` updates the count, tooltip,
 * status line, the "Do załatwienia" queue and the login/logout
 * item. Renders run one at a time, in order. A tray left over from
 * a previous load of this window (page reload) is removed first.
 */
export async function createTray(actions: TrayActions): Promise<Tray> {
  await TrayIcon.removeById(TRAY_ID).catch(() => undefined);
  let loggedIn = false;
  const status = await MenuItem.new({ id: 'status', text: 'Niezalogowano', enabled: false });
  const account = await MenuItem.new({ id: 'account', text: 'Zaloguj…', action: () => (loggedIn ? actions.logout() : actions.login()) });
  const menu = await Menu.new({
    items: [
      status,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ id: 'queue-title', text: 'Do załatwienia', enabled: false }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ id: 'inbox', text: 'Otwórz skrzynkę', action: actions.openInbox }),
      await MenuItem.new({ id: 'refresh', text: 'Odśwież', action: actions.refresh }),
      await MenuItem.new({ id: 'settings', text: 'Ustawienia…', action: actions.openSettings }),
      account,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Quit', text: 'Zakończ CogniFly' }),
    ],
  });
  const queue = queueSection(menu, (action) => runAction(actions, action));
  await queue.sync(attentionEntries([], false));
  const icon = await TrayIcon.new({
    id: TRAY_ID, icon: (await defaultWindowIcon()) ?? undefined, menu, tooltip: 'CogniFly',
    menuOnLeftClick: false,
    action: (event) => {
      if (isLeftClick(event)) actions.openMain();
    },
  });
  let chain: Promise<void> = Promise.resolve();
  const draw = async (view: InboxView) => {
    loggedIn = view.loggedIn;
    const state = trayState(view);
    await icon.setTitle(trayTitle(state));
    await icon.setTooltip(trayTooltip(state));
    await status.setText(menuText(statusFor(view)));
    await queue.sync(attentionEntries(attentionQueue(view), view.loggedIn));
    await account.setText(view.loggedIn ? 'Wyloguj' : 'Zaloguj…');
  };
  return {
    render(view) {
      const next = chain.then(() => draw(view));
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

/** One queue line: its menu item and what the item shows now. */
interface QueueLine { item: MenuItem; entry: AttentionEntry }

/** The queue lines of the menu, kept in sync with the entries. */
interface QueueSection { sync(entries: readonly AttentionEntry[]): Promise<void> }

/**
 * Manages the queue lines of the menu without rebuilding it.
 *
 * Call: `queueSection(menu, run)` once; `sync(entries)` per render.
 * Expects: the tray menu; `run` performs a line's action.
 * Output: the section; `sync` changes text and enabled state of
 * the shown lines in place, inserts lines from `QUEUE_START` when
 * more are needed and removes extra ones (kept for reuse, so menu
 * resources do not pile up).
 */
function queueSection(menu: Menu, run: (action: AttentionAction) => void): QueueSection {
  const shown: QueueLine[] = [];
  const spare: QueueLine[] = [];
  const newLine = async (): Promise<QueueLine> => {
    const entry: AttentionEntry = { text: ' ', enabled: true, action: null };
    const line: { item?: MenuItem; entry: AttentionEntry } = { entry };
    line.item = await MenuItem.new({ text: entry.text, action: () => {
      if (line.entry.action) run(line.entry.action);
    } });
    return line as QueueLine;
  };
  return {
    async sync(entries) {
      for (const [i, entry] of entries.entries()) {
        let line = shown[i];
        if (!line) {
          line = spare.pop() ?? await newLine();
          await menu.insert(line.item, QUEUE_START + i);
          shown.push(line);
        }
        await updateLine(line.item, line.entry, entry);
        line.entry = entry;
      }
      while (shown.length > entries.length) {
        const line = shown.pop()!;
        await menu.remove(line.item);
        spare.push(line);
      }
    },
  };
}

/**
 * Updates one menu line where it changed.
 *
 * Call: `await updateLine(item, before, after)`.
 * Expects: the line's item, what it shows and what it should show.
 * Output: none; only changed text or enabled state is sent.
 */
async function updateLine(item: MenuItem, before: AttentionEntry, after: AttentionEntry): Promise<void> {
  if (before.text !== after.text) await item.setText(after.text);
  if (before.enabled !== after.enabled) await item.setEnabled(after.enabled);
}

/**
 * Performs the action of a queue line.
 *
 * Call: `runAction(actions, action)` on a click.
 * Expects: the tray actions and a line's action.
 * Output: none; refreshes, opens the main window, or opens a
 * screen with its highlight.
 */
function runAction(actions: TrayActions, action: AttentionAction): void {
  if (action.kind === 'refresh') actions.refresh();
  else if (action.kind === 'main') actions.openMain();
  else actions.show(action.screen, action.highlight);
}

/**
 * What the title and tooltip reflect.
 *
 * Call: `trayState(view)`.
 * Expects: a view.
 * Output: session, offline flag, waiting tasks and file counts.
 */
function trayState(view: InboxView): TrayState {
  return { loggedIn: view.loggedIn, offline: view.offline, waiting: waitingCount(view), ...view.files.counts };
}

/**
 * Tells a finished left click apart from other tray events.
 *
 * Call: `isLeftClick(event)` in the tray action handler.
 * Expects: any tray event.
 * Output: `true` only for a left-button click on release.
 */
function isLeftClick(event: TrayIconEvent): boolean {
  return event.type === 'Click' && event.button === 'Left' && event.buttonState === 'Up';
}

/**
 * Status line of the menu.
 *
 * Call: `statusFor(view)`.
 * Expects: a view.
 * Output: Polish status: logged out, offline, or count + e-mail.
 */
function statusFor(view: InboxView): string {
  if (!view.loggedIn) return 'Niezalogowano';
  if (view.offline) return `Brak połączenia — ${view.email ?? ''}`.trim();
  return `Czeka: ${waitingCount(view)} — ${view.email ?? ''}`.trim();
}
