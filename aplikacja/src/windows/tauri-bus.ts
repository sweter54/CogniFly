// Tauri implementation of the rpc `Bus`: emit to a window label and
// listen only to events addressed to the current window.
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Bus } from '../logic/rpc.js';

/**
 * Creates the event bus of the current window.
 *
 * Call: `tauriBus()` once per window script.
 * Expects: to run inside a Tauri webview with `core:event:default`.
 * Output: a `Bus` whose `listen` sees only events targeted at this
 * window (not broadcasts to other windows).
 */
export function tauriBus(): Bus {
  const self = getCurrentWebviewWindow();
  return {
    emitTo: (target, event, payload) => emitTo(target, event, payload),
    listen: (event, handler) => self.listen(event, (e) => handler(e.payload)),
  };
}

/**
 * Label of the current window.
 *
 * Call: `currentLabel()`.
 * Expects: a Tauri webview.
 * Output: the window label from tauri.conf.json.
 */
export function currentLabel(): string {
  return getCurrentWebviewWindow().label;
}
