// Forwards webview errors to the app log (stdout in dev, log file in
// the app's log directory), so failures are visible outside devtools.
// Only error codes and messages are logged, never tokens or task data.
import { error as logError, info as logInfo } from '@tauri-apps/plugin-log';

/**
 * Logs one failure with its context.
 *
 * Call: `reportError('tray.openInbox', e)`.
 * Expects: a short context label and anything thrown.
 * Output: none; never throws (logging must not break the app).
 */
export function reportError(context: string, e: unknown): void {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  logError(`[${context}] ${text}`).catch(() => undefined);
}

/**
 * Logs an informational line.
 *
 * Call: `reportInfo('background started')`.
 * Expects: text without secrets.
 * Output: none; never throws.
 */
export function reportInfo(text: string): void {
  logInfo(text).catch(() => undefined);
}

/**
 * Catches uncaught errors and rejections of this window.
 *
 * Call: `installErrorLog('main')` first thing in a window script.
 * Expects: a Tauri webview with `log:default`.
 * Output: none; every uncaught error is reported with the window name.
 */
export function installErrorLog(windowName: string): void {
  window.addEventListener('error', (ev) => reportError(`${windowName}.uncaught`, ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(`${windowName}.unhandled`, ev.reason));
}
