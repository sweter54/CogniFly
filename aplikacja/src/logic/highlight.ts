// When to flash a task in the inbox. Pure timing logic; the screen
// only applies the decision to the DOM.

/** How long a highlighted task flashes, in ms. */
export const FLASH_MS = 5_000;
/** How long to wait for a task that is not on the list yet, in ms. */
export const WAIT_MS = 15_000;

/** A pending or running highlight of one task. */
export interface Highlight {
  id: string;
  /** Give up if the task has not appeared by then. */
  deadline: number;
  /** Set once the flash started: when it ends. */
  until?: number;
}

/** What the screen should do with the task element on a render. */
export type FlashAction = 'start' | 'keep' | 'none';

/**
 * Creates a highlight request for a task.
 *
 * Call: `requestHighlight(id, Date.now())`.
 * Expects: a task id and the current time in ms.
 * Output: a request that waits up to `WAIT_MS` for the task.
 */
export function requestHighlight(id: string, now: number): Highlight {
  return { id, deadline: now + WAIT_MS };
}

/**
 * Decides the flash on a render of the list.
 *
 * Call: `onRender(h, present, Date.now())` after every redraw.
 * Expects: the current request (or null) and whether its task is on
 * the list now.
 * Output: the next request state and the action: `start` (scroll,
 * focus and flash), `keep` (re-apply the flash to the new element)
 * or `none`. The request ends after `FLASH_MS` or at its deadline.
 */
export function onRender(h: Highlight | null, present: boolean, now: number): { next: Highlight | null; flash: FlashAction } {
  if (!h) return { next: null, flash: 'none' };
  if (h.until === undefined) {
    if (present) return { next: { ...h, until: now + FLASH_MS }, flash: 'start' };
    return now > h.deadline ? { next: null, flash: 'none' } : { next: h, flash: 'none' };
  }
  if (now >= h.until) return { next: null, flash: 'none' };
  return { next: h, flash: present ? 'keep' : 'none' };
}
