// Test doubles shared by the logic tests.
import type { FetchFn } from '../src/logic/http.js';
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
