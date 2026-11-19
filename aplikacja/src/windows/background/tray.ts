// Menu-bar icon: count next to the icon and a small menu. Rendering
// only; actions are passed in by the background window.
import { defaultWindowIcon } from '@tauri-apps/api/app';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { TrayIcon, type TrayIconEvent } from '@tauri-apps/api/tray';
import { waitingCount } from '../../logic/controller.js';
import { trayTitle } from '../../logic/notify.js';
import type { InboxView } from '../protocol.js';

/** Actions triggered from the icon and its menu. */
export interface TrayActions {
  /** Left click on the icon (the menu opens on right click). */
  openMain(): void;
  openInbox(): void;
  refresh(): void;
  openSettings(): void;
  login(): void;
  logout(): void;
}

/** Id of the single tray icon of the app. */
const TRAY_ID = 'cognifly';

/** Handle to update the tray after each view change. */
export interface Tray { render(view: InboxView): Promise<void> }

/**
 * Creates the tray icon and its menu.
 *
 * Call: `await createTray(actions)` once in the background window.
 * Expects: `core:tray`, `core:menu` and default-icon permissions.
 * Output: a `Tray`: left click opens the main window, right click
 * shows the menu; its `render(view)` updates the count, tooltip,
 * the status line and the login/logout item. A tray left over from a
 * previous load of this window (page reload) is removed first, so
 * there is always exactly one icon.
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
      await MenuItem.new({ id: 'inbox', text: 'Otwórz skrzynkę', action: actions.openInbox }),
      await MenuItem.new({ id: 'refresh', text: 'Odśwież', action: actions.refresh }),
      await MenuItem.new({ id: 'settings', text: 'Ustawienia…', action: actions.openSettings }),
      account,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Quit', text: 'Zakończ CogniFly' }),
    ],
  });
  const icon = await TrayIcon.new({
    id: TRAY_ID, icon: (await defaultWindowIcon()) ?? undefined, menu, tooltip: 'CogniFly',
    menuOnLeftClick: false,
    action: (event) => {
      if (isLeftClick(event)) actions.openMain();
    },
  });
  return {
    async render(view) {
      loggedIn = view.loggedIn;
      await icon.setTitle(trayTitle({ loggedIn: view.loggedIn, offline: view.offline, waiting: waitingCount(view) }));
      await icon.setTooltip(tooltipFor(view));
      await status.setText(statusFor(view));
      await account.setText(view.loggedIn ? 'Wyloguj' : 'Zaloguj…');
    },
  };
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

/**
 * Tooltip of the icon.
 *
 * Call: `tooltipFor(view)`.
 * Expects: a view.
 * Output: `CogniFly` plus the status line.
 */
function tooltipFor(view: InboxView): string {
  return `CogniFly — ${statusFor(view)}`;
}
