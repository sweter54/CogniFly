// Tauri implementations of the controller ports.
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { openUrl as openWithOs, revealItemInDir } from '@tauri-apps/plugin-opener';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { taskFromAppLink } from '../../logic/app-link.js';
import type { HeartwoodPort, HwInfo, HwReply } from '../../logic/heartwood.js';
import type { FetchFn } from '../../logic/http.js';
import { reportError } from '../diagnostics.js';
import type { Vault } from '../../logic/session.js';
import { INBOX_EVENT, SCREEN_EVENT, WINDOWS, type InboxView, type Screen } from '../protocol.js';

/** Keychain vault backed by the Rust `vault_*` commands. */
export const keychainVault: Vault = {
  read: () => invoke<string | null>('vault_read'),
  write: (value) => invoke<void>('vault_write', { value }),
  remove: () => invoke<void>('vault_delete'),
};

/**
 * Fetch through the HTTP plugin (no CORS; URL scope in capabilities).
 *
 * Call: as `FetchFn`.
 * Expects: an https URL allowed by the capability scope.
 * Output: the response. A rejection (offline, timeout, scope denied)
 * is logged with the host only, then rethrown.
 */
export const pluginFetch: FetchFn = (url, init) => httpFetch(url, init).catch((e: unknown) => {
  reportError(`http ${new URL(url).host}`, e);
  throw e;
});

/**
 * Brings the main window to the front on a screen.
 *
 * Call: `await showScreen('login')` or `showScreen('inbox', taskId)`
 * from the tray, notification click, controller or an app link.
 * Expects: the `main` window declared in tauri.conf.json.
 * Output: none; never throws, so menu actions and startup keep
 * working; failures go to the app log. The screen request is sent
 * first, so no stale screen flashes.
 */
export async function showScreen(screen: Screen, highlightTask?: string): Promise<void> {
  try {
    await emitTo(WINDOWS.main, SCREEN_EVENT, { screen, highlight: highlightTask ?? null });
    const w = await WebviewWindow.getByLabel(WINDOWS.main);
    if (!w) throw new Error('main window missing');
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch (e) {
    reportError(`showScreen(${screen})`, e);
  }
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

/**
 * Opens a URL with the default handler of the OS.
 *
 * Call: as the controller's `openUrl` port.
 * Expects: a `claude://` link; the capability scope refuses others.
 * Output: none; rejects when the scope or the OS refuses.
 */
export async function openUrl(url: string): Promise<void> {
  await openWithOs(url);
}

/**
 * Shows a local item in Finder (selected in its parent folder).
 *
 * Call: as the controller's `revealFolder` port.
 * Expects: a path already checked to be under the Heartwood root.
 * Output: none; nothing is opened or launched (unlike `openPath`,
 * which would run a synced `X.app`); rejects when the OS refuses.
 */
export async function revealFolder(path: string): Promise<void> {
  await revealItemInDir(path);
}

/**
 * Shows the macOS folder picker over the main window.
 *
 * Call: as the controller's `pickFolder` port.
 * Expects: a start folder or `''` (then the OS default).
 * Output: the chosen absolute path, or `null` when cancelled. Picking
 * grants no file access to the app (no fs plugin is registered).
 */
export async function pickFolder(startAt: string): Promise<string | null> {
  return invoke<string | null>('pick_folder', { start: startAt, title: 'Wybierz folder pracy dla Claude' });
}

/**
 * Shows the macOS picker for files under the Heartwood root, over
 * the main window (a panel of the hidden background window can stay
 * invisible).
 *
 * Call: as `HeartwoodPort.pickFiles`.
 * Expects: the root folder (the dialog starts there).
 * Output: the chosen absolute paths, `[]` when cancelled; the
 * controller still checks that each lies under the root.
 */
async function pickFiles(root: string): Promise<string[]> {
  return invoke<string[]>('pick_files', { root });
}

/**
 * Heartwood daemon backed by the Rust `heartwood_*` commands.
 * Rejections carry code strings (`DISABLED`, `NOT_RUNNING`, …).
 */
export const heartwoodPort: HeartwoodPort = {
  start: (serverUrl, wsUrl, identityUrl, org, root) => invoke<HwInfo>('heartwood_start', { serverUrl, wsUrl, identityUrl, org, root }),
  stop: () => invoke<void>('heartwood_stop'),
  info: () => invoke<HwInfo>('heartwood_info'),
  call: (request) => invoke<HwReply>('heartwood_call', { request }),
  pickFiles,
};

/**
 * Routes `cognifly://` links to a handler.
 *
 * Call: `await listenAppLinks(onTask)` once at start.
 * Expects: `deep-link:default`; the scheme registered in the bundle.
 * Output: none; links that start the app and links arriving later
 * both reach `onTask` with a validated task id; others are ignored.
 */
export async function listenAppLinks(onTask: (id: string) => void): Promise<void> {
  const handle = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      const id = taskFromAppLink(url);
      if (id) onTask(id);
      else reportError('appLink', 'ignored link');
    }
  };
  await onOpenUrl(handle);
  handle(await getCurrent());
}
