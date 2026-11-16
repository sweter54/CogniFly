// Tauri implementations of the controller ports.
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { FetchFn } from '../../logic/http.js';
import type { Vault } from '../../logic/session.js';
import { INBOX_EVENT, SCREEN_EVENT, WINDOWS, type InboxView, type Screen } from '../protocol.js';

/** Keychain vault backed by the Rust `vault_*` commands. */
export const keychainVault: Vault = {
  read: () => invoke<string | null>('vault_read'),
  write: (value) => invoke<void>('vault_write', { value }),
  remove: () => invoke<void>('vault_delete'),
};

/** Fetch through the HTTP plugin (no CORS; URL scope in capabilities). */
export const pluginFetch: FetchFn = (url, init) => httpFetch(url, init);

/**
 * Brings the main window to the front on a screen.
 *
 * Call: `await showScreen('login')` from the tray, notification click
 * or the controller.
 * Expects: the `main` window declared in tauri.conf.json.
 * Output: none. The screen request is sent before showing, so the
 * window never flashes the previous screen.
 */
export async function showScreen(screen: Screen): Promise<void> {
  await emitTo(WINDOWS.main, SCREEN_EVENT, { screen }).catch(() => undefined);
  const w = await WebviewWindow.getByLabel(WINDOWS.main);
  if (!w) return;
  await w.show();
  await w.unminimize();
  await w.setFocus();
}

/**
 * Pushes the view to the main window.
 *
 * Call: `pushView(view)` after each render.
 * Expects: nothing; errors are ignored (window may be loading).
 * Output: none.
 */
export function pushView(view: InboxView): void {
  emitTo(WINDOWS.main, INBOX_EVENT, view).catch(() => undefined);
}

/**
 * Prepares notifications and routes clicks to the inbox screen.
 *
 * Call: `await setupNotifications(onClick)` once at start.
 * Expects: `notification:default` permission.
 * Output: `true` when notifications are allowed. Registering the
 * click listener is required on desktop for clicks to be reported.
 */
export async function setupNotifications(onClick: () => void): Promise<boolean> {
  await onAction(() => onClick());
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

/**
 * Shows one notification.
 *
 * Call: `await notify(title, body)`.
 * Expects: prepared text (see `notificationBody`).
 * Output: none.
 */
export async function notify(title: string, body: string): Promise<void> {
  sendNotification({ title, body });
}
