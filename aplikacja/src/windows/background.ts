// Background window entry: wires the controller to Tauri (tray,
// notifications, keychain, HTTP) and serves the UI windows.
import { Controller, POLL_INTERVAL_MS } from '../logic/controller.js';
import { errorCode } from '../logic/errors.js';
import { rpcServer } from '../logic/rpc.js';
import { keychainVault, notify, pluginFetch, pushView, setupNotifications, showScreen } from './background/platform.js';
import { createTray, type Tray } from './background/tray.js';
import type { InboxView } from './protocol.js';
import { installErrorLog, reportError, reportInfo } from './diagnostics.js';
import { tauriBus } from './tauri-bus.js';

/**
 * Maps an rpc failure to its code and logs it.
 *
 * Call: as the `toCode` of `rpcServer`.
 * Expects: anything thrown by a handler.
 * Output: the stable code sent to the window. Every failure is
 * logged with its detail (e.g. the Cognito error type); messages
 * never contain codes typed by the user or tokens.
 */
function codeAndLog(e: unknown): string {
  reportError('rpc', e);
  return errorCode(e);
}

/**
 * Starts the background window.
 *
 * Call: once, at module load.
 * Expects: to run in the hidden `background` window.
 * Output: none; polls every `POLL_INTERVAL_MS` until the app quits.
 * Start errors go to the app log (no tokens).
 */
async function main(): Promise<void> {
  let tray: Tray | null = null;
  const render = (view: InboxView) => {
    tray?.render(view).catch(() => undefined);
    pushView(view);
  };
  const controller = new Controller({ store: localStorage, vault: keychainVault, fetch: pluginFetch, notify, render, showScreen });
  await rpcServer(tauriBus(), controller.handlers(), codeAndLog);
  tray = await createTray({
    openInbox: () => void showScreen('inbox'),
    refresh: () => void controller.poll(),
    openSettings: () => void showScreen('settings'),
    login: () => void showScreen('login'),
    logout: () => void controller.logout(),
  });
  await setupNotifications(() => void showScreen('inbox')).catch(() => false);
  await controller.start();
  setInterval(() => void controller.poll(), POLL_INTERVAL_MS);
}

installErrorLog('background');
main().then(() => reportInfo('background started'), (e) => reportError('background.start', e));
