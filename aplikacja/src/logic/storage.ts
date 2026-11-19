// JSON helpers over a Storage-like object (window.localStorage in the
// app, an in-memory map in tests). Only non-secret data goes here.

/** The subset of `Storage` the app uses. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Reads and parses a JSON value.
 *
 * Call: `readJson(store, key)`.
 * Expects: any store; a missing, corrupt or inaccessible value is
 * treated as absent.
 * Output: the parsed value or `null`.
 */
export function readJson(store: KeyValueStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Serialises and writes a JSON value.
 *
 * Call: `writeJson(store, key, value)`.
 * Expects: `value` JSON-serialisable.
 * Output: none; storage errors (quota, private mode) are ignored
 * because everything stored is a re-creatable convenience.
 */
export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* non-critical */
  }
}

/**
 * Creates an in-memory store (tests and fallback).
 *
 * Call: `memoryStore()`.
 * Expects: nothing.
 * Output: a fresh, empty `KeyValueStore`.
 */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
