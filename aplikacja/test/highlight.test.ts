import { describe, expect, it } from 'vitest';
import { FLASH_MS, WAIT_MS, onRender, requestHighlight } from '../src/logic/highlight.js';

describe('highlight', () => {
  it('starts the 5 s flash as soon as the task is on the list', () => {
    const r = onRender(requestHighlight('zad_1', 1000), true, 1000);
    expect(FLASH_MS).toBe(5_000);
    expect(r).toEqual({ next: { id: 'zad_1', deadline: 1000 + WAIT_MS, until: 1000 + FLASH_MS }, flash: 'start' });
  });

  it('waits for a task that is not on the list yet (handed over, not fetched)', () => {
    const h = requestHighlight('zad_1', 0);
    const waiting = onRender(h, false, 2000);
    expect(waiting).toEqual({ next: h, flash: 'none' });
    expect(onRender(waiting.next, true, 3000)).toMatchObject({ flash: 'start', next: { until: 3000 + FLASH_MS } });
  });

  it('gives up when the task never appears', () => {
    expect(onRender(requestHighlight('zad_1', 0), false, WAIT_MS + 1)).toEqual({ next: null, flash: 'none' });
  });

  it('keeps the flash across redraws (poll, window focus) until it ends', () => {
    const started = onRender(requestHighlight('zad_1', 0), true, 0).next;
    expect(onRender(started, true, FLASH_MS - 1)).toEqual({ next: started, flash: 'keep' });
    expect(onRender(started, false, FLASH_MS - 1)).toEqual({ next: started, flash: 'none' });
    expect(onRender(started, true, FLASH_MS)).toEqual({ next: null, flash: 'none' });
  });

  it('does nothing without a request', () => {
    expect(onRender(null, true, 0)).toEqual({ next: null, flash: 'none' });
  });
});
