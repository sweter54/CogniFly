// Background window entry: wires the controller to Tauri (tray,
// notifications, keychain, HTTP) and serves the UI windows.
import { Controller, POLL_INTERVAL_MS } from '../logic/controller.js';
import { errorCode } from '../logic/errors.js';
import { rpcServer } from '../logic/rpc.js';
import { keychainVault, notify, pluginFetch, pushInbox, setupNotifications, showWindow } from './background/platform.js';
import { createTray, type Tray } from './background/tray.js';
import type { InboxView } from './protocol.js';
import { tauriBus } from './tauri-bus.js';

/**
 * Starts the background window.
 *
 * Call: once, at module load.
 * Expects: to run in the hidden `background` window.
 * Output: none; polls every `POLL_INTERVAL_MS` until the app quits.
 * Errors are reported to the console as codes only (no tokens).
 */
async function main(): Promise<void> {
  let tray: Tray | null = null;
  const render = (view: InboxView) => {
    tray?.render(view).catch(() => undefined);
    pushInbox(view);
  };
  const controller = new Controller({ store: localStorage, vault: keychainVault, fetch: pluginFetch, notify, render, showWindow });
  await rpcServer(tauriBus(), controller.handlers(), errorCode);
  tray = await createTray({
    openInbox: () => void showWindow('inbox'),
    refresh: () => void controller.poll(),
    openSettings: () => void showWindow('settings'),
    login: () => void showWindow('login'),
    logout: () => void controller.logout(),
  });
  await setupNotifications(() => void showWindow('inbox')).catch(() => false);
  await controller.start();
  setInterval(() => void controller.poll(), POLL_INTERVAL_MS);
}

main().catch((e) => console.error('CogniFly start failed:', errorCode(e)));
