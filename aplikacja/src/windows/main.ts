// Main window: one place that guides the user (login), shows the inbox
// and the settings. Switches screens on tray / notification requests
// and keeps the header in sync with the session.
import { INBOX_EVENT, SCREEN_EVENT, type InboxView, type Screen } from './protocol.js';
import { mountInbox } from './screens/inbox.js';
import { mountLogin } from './screens/login.js';
import { mountReviewRequest } from './screens/review-request.js';
import { mountSettings } from './screens/settings.js';
import { installErrorLog, reportError } from './diagnostics.js';
import { tauriBus } from './tauri-bus.js';
import { byId, connect, messageFor, setStatus } from './ui.js';

const SCREENS: Screen[] = ['login', 'inbox', 'settings'];

/**
 * Updates the header for the session state.
 *
 * Call: `renderHeader(view)` on every view change.
 * Expects: main.html header markup.
 * Output: none; nav and logout show only when logged in.
 */
function renderHeader(view: InboxView): void {
  byId('nav').hidden = needsSetup(view);
  byId('logout').hidden = !view.loggedIn;
  byId('who').textContent = view.loggedIn ? (view.email ?? '') : '';
}

/**
 * Tells whether the guided setup still has steps to do.
 *
 * Call: `needsSetup(view)`.
 * Expects: a view.
 * Output: `true` when logged out or when no work folder is chosen.
 */
function needsSetup(view: InboxView): boolean {
  return !view.loggedIn || !view.workFolder;
}

/**
 * Shows one screen and hides the others.
 *
 * Call: `showOnly('inbox')`.
 * Expects: sections `#screen-<name>`.
 * Output: none; the status line is cleared and the tab marked.
 */
function showOnly(screen: Screen): void {
  for (const s of SCREENS) byId(`screen-${s}`).hidden = s !== screen;
  for (const tab of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
    tab.dataset.active = String(tab.dataset.go === screen);
  }
  setStatus('');
}

/**
 * Window entry: mounts screens and routes between them.
 *
 * Call: once at module load.
 * Expects: main.html markup and a running background window.
 * Output: none. Logged-out users always land on the guided login;
 * the inbox and settings follow tray and notification requests.
 */
async function main(): Promise<void> {
  const call = await connect();
  let view = await call('inbox.get', {});
  let current: Screen = 'login';
  const login = mountLogin(call, () => view.workFolder !== '');
  const inbox = mountInbox(call);
  mountReviewRequest(call, () => view.osoba, () => inbox.refresh());
  const settings = mountSettings(call, () => go(view.loggedIn ? 'inbox' : 'login'));

  /**
   * Navigates to a screen; until setup is finished (logged in and a
   * work folder chosen) only the setup is reachable.
   * Call: `go(screen)`. Expects: any screen.
   * Output: none.
   */
  function go(screen: Screen): void {
    current = needsSetup(view) ? 'login' : screen;
    showOnly(current);
    if (current === 'inbox') inbox.render(view);
    if (current === 'settings') {
      settings.showFolder(view.workFolder);
      settings.load().catch((e) => setStatus(messageFor(e), 'error'));
    }
    if (current === 'login' && !view.loggedIn) login.reset();
    else if (current === 'login' && !view.workFolder) login.showFolder();
  }

  /**
   * Applies a new view from the background window.
   * Call: on `INBOX_EVENT`. Expects: a view.
   * Output: none; leaves the inbox when the session ended.
   */
  function apply(next: InboxView): void {
    const loggedOut = view.loggedIn && !next.loggedIn;
    view = next;
    renderHeader(view);
    if (loggedOut) go('login');
    else if (current === 'inbox') inbox.render(view);
    else if (current === 'settings') settings.showFolder(view.workFolder);
  }

  const bus = tauriBus();
  await bus.listen(INBOX_EVENT, (p) => apply(p as InboxView));
  await bus.listen(SCREEN_EVENT, (p) => {
    const { screen, highlight } = p as { screen: Screen; highlight?: string | null };
    go(screen);
    if (highlight && current === 'inbox') inbox.highlight(highlight);
  });
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-go]'))) {
    el.addEventListener('click', () => go(el.dataset.go as Screen));
  }
  // Coming back from Claude or the browser: show changes at once instead of waiting for the next poll.
  window.addEventListener('focus', () => {
    if (current === 'inbox') inbox.refresh();
  });
  byId('logout').addEventListener('click', () => void call('session.logout', {}).catch((e) => setStatus(messageFor(e), 'error')));
  renderHeader(view);
  go(view.loggedIn ? 'inbox' : 'login');
}

installErrorLog('main');
main().catch((e) => {
  reportError('main.start', e);
  setStatus(messageFor(e), 'error');
});
