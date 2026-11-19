// Test doubles shared by the logic tests.
import type { FetchFn } from '../src/logic/http.js';
import type { Bus } from '../src/logic/rpc.js';
import type { Vault } from '../src/logic/session.js';

/** One scripted answer: a response or a thrown error. */
export type Scripted = { status: number; body?: unknown; raw?: string } | Error;

/** Recorded request. */
export interface Recorded { url: string; init: RequestInit; body: unknown }

/**
 * Fake fetch answering from a script, in order.
 *
 * Call: `const f = scriptedFetch([{ status: 200, body: {...} }])`.
 * Expects: one entry per expected request.
 * Output: `{ fetch, calls }`; running past the script throws.
 */
export function scriptedFetch(script: Scripted[]): { fetch: FetchFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...script];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    return new Response(text, { status: next.status });
  };
  return { fetch, calls };
}

/**
 * In-memory vault.
 *
 * Call: `memoryVault(initial?)`.
 * Expects: optional initial raw value.
 * Output: a `Vault` plus `value()` to inspect the stored string.
 */
export function memoryVault(initial: string | null = null): Vault & { value(): string | null } {
  let stored = initial;
  return {
    read: async () => stored,
    write: async (v) => { stored = v; },
    remove: async () => { stored = null; },
    value: () => stored,
  };
}

/**
 * Header lookup on a recorded request.
 *
 * Call: `header(call, 'Authorization')`.
 * Expects: a recorded request with a plain-object `headers`.
 * Output: the header value or `undefined`.
 */
export function header(call: Recorded, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

/** A `status` reply shaped like contract section 9. */
export const STATUS_REPLY = {
  ok: true,
  running: true,
  connected: true,
  spaces: [
    { space: 'ws:w1', folder: 'wspolne', lastSeq: 5, serverSeq: 7, unsent: 3 },
    { space: 'prv:michal', folder: 'Prywatne', lastSeq: 2, serverSeq: null, unsent: 4 },
  ],
  pending: [{ space: 'ws:w1', op: 'put', path: 'a.txt', toPath: null, status: 'waiting', message: null }],
  conflicts: [
    { space: 'ws:w1', path: 'b.docx', copyPath: 'b (konflikt).docx', at: '2026-11-19T10:00:00Z', message: 'Ktoś zmienił plik.' },
    { space: 'ws:w1', path: 'c.docx', copyPath: 'c (konflikt).docx', at: '2026-11-19T10:01:00Z', message: 'Ktoś zmienił plik.' },
  ],
  skipped: [
    { space: 'ws:w1', path: 'x:y', reason: 'name:NAME_INVALID', reasonText: 'nieprawidłowa nazwa', suggestion: 'x_y', hint: 'zmień nazwę na „x_y”' },
    { space: 'ws:w1', path: 'big.iso', reason: 'too_large', reasonText: 'za duży', suggestion: null, hint: null },
  ],
  issues: [{ space: '', message: 'Brak połączenia z serwerem.' }],
};

/**
 * In-memory event bus: routes events by target window label.
 *
 * Call: `const b = memoryBus(); rpcServer(b('background'), …)`.
 * Expects: nothing.
 * Output: a factory of `Bus` per window label; payloads are cloned.
 */
export function memoryBus(): (label: string) => Bus {
  const listeners = new Map<string, Map<string, ((p: unknown) => void)[]>>();
  return (label: string): Bus => ({
    async emitTo(target, event, payload) {
      for (const h of listeners.get(target)?.get(event) ?? []) h(structuredClone(payload));
    },
    async listen(event, handler) {
      const byEvent = listeners.get(label) ?? new Map();
      listeners.set(label, byEvent);
      byEvent.set(event, [...(byEvent.get(event) ?? []), handler]);
      return () => undefined;
    },
  });
}
