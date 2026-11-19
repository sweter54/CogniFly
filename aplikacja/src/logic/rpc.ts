// Request/reply between UI windows and the background window over
// Tauri events. The transport is injected, so this is testable and the
// UI windows never need more than event permissions.

/** Event carrying a request to the background window. */
export const REQUEST_EVENT = 'cognifly://request';
/** Event carrying a reply back to the asking window. */
export const REPLY_EVENT = 'cognifly://reply';
/** Label of the window that serves requests. */
export const SERVER_WINDOW = 'background';

/** Minimal event transport (Tauri `emitTo` + window `listen`). */
export interface Bus {
  emitTo(target: string, event: string, payload: unknown): Promise<void>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** Request envelope. */
export interface RpcRequest { id: string; from: string; method: string; params: unknown }
/** Reply envelope; `error` is a stable code, never a raw message;
 *  `message` is only a vetted text (e.g. a Heartwood refusal). */
export type RpcReply =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string; message?: string };

/** Server-side handler of one method. */
export type Handler = (params: unknown) => Promise<unknown>;

/** Error thrown on the client side with the server's code. */
export class RpcError extends Error {
  /**
   * Call: `new RpcError(code, detail?)`.
   * Expects: a stable error code; optionally the vetted text the
   * server sent with it (shown by the UI, e.g. via `hwMessage`).
   * Output: error whose message is the code.
   */
  constructor(readonly code: string, readonly detail?: string) {
    super(code);
    this.name = 'RpcError';
  }
}

/**
 * Creates a function that calls the background window.
 *
 * Call: `const call = await rpcClient(bus, selfLabel)`, then
 * `await call('inbox.list', {})` or `call(m, p, waitMs)` for calls
 * that wait for the user (e.g. a file dialog).
 * Expects: `selfLabel` = label of the calling window.
 * Output: the handler's value.
 * Throws: `RpcError(code, detail?)` on a server error,
 * `RpcError('TIMEOUT')` after the per-call or default `timeoutMs`
 * (20 s) without reply.
 */
export async function rpcClient(bus: Bus, selfLabel: string, timeoutMs = 20_000) {
  const pending = new Map<string, (r: RpcReply) => void>();
  await bus.listen(REPLY_EVENT, (payload) => {
    const reply = payload as RpcReply;
    pending.get(reply?.id)?.(reply);
  });
  return (method: string, params: unknown = {}, waitMs = timeoutMs): Promise<unknown> => new Promise((resolve, reject) => {
    const id = newId();
    const timer = setTimeout(() => settle({ id, ok: false, error: 'TIMEOUT' }), waitMs);
    /**
     * Finishes this call once (reply, timeout or transport error).
     * Call: `settle(reply)`. Expects: the reply for `id`.
     * Output: none; resolves or rejects the promise, clears the timer.
     */
    function settle(r: RpcReply) {
      clearTimeout(timer);
      pending.delete(id);
      if (r.ok) resolve(r.value); else reject(new RpcError(r.error, r.message));
    }
    pending.set(id, settle);
    bus.emitTo(SERVER_WINDOW, REQUEST_EVENT, { id, from: selfLabel, method, params })
      .catch(() => settle({ id, ok: false, error: 'TRANSPORT' }));
  });
}

/** A call function as returned by `rpcClient`. */
export type RawCall = (method: string, params?: unknown, waitMs?: number) => Promise<unknown>;

/**
 * Calls the background window, retrying while it is still starting.
 *
 * Call: `await callWhenReady(call, 'inbox.get', {})` at window start.
 * Expects: a call from `rpcClient`; an idempotent method (a request
 * sent before the background window listens is lost, so it is resent).
 * Options: `attemptMs` per try (default 2 s), `totalMs` overall
 * (default 60 s).
 * Output: the handler's value.
 * Throws: `RpcError('TIMEOUT')` after `totalMs`; any other error at
 * once (the background window answered).
 */
export async function callWhenReady(
  call: RawCall, method: string, params: unknown,
  o: { attemptMs?: number; totalMs?: number } = {},
): Promise<unknown> {
  const attemptMs = o.attemptMs ?? 2_000;
  const deadline = Date.now() + (o.totalMs ?? 60_000);
  for (;;) {
    try {
      return await call(method, params, attemptMs);
    } catch (e) {
      if (!(e instanceof RpcError && e.code === 'TIMEOUT') || Date.now() + attemptMs > deadline) throw e;
    }
  }
}

/** Maps a thrown value to a text safe to show, or `undefined`. */
export type ToDetail = (e: unknown) => string | undefined;

/**
 * Serves requests in the background window.
 *
 * Call: `await rpcServer(bus, handlers, toCode, toDetail?)`.
 * Expects: handlers keyed by method; `toCode` maps thrown values to
 * stable codes (must not leak messages or tokens); `toDetail` gives
 * a vetted user text for the few errors that carry one.
 * Output: unlisten function. Unknown methods reply `UNKNOWN_METHOD`;
 * malformed envelopes are ignored.
 */
export function rpcServer(bus: Bus, handlers: Record<string, Handler>, toCode: (e: unknown) => string, toDetail?: ToDetail) {
  return bus.listen(REQUEST_EVENT, async (payload) => {
    const req = payload as Partial<RpcRequest>;
    if (typeof req?.id !== 'string' || typeof req.from !== 'string' || typeof req.method !== 'string') return;
    const reply = await runHandler(handlers, req as RpcRequest, toCode, toDetail);
    await bus.emitTo(req.from, REPLY_EVENT, reply).catch(() => undefined);
  });
}

/**
 * Runs one handler and wraps the outcome.
 *
 * Call: `await runHandler(handlers, request, toCode, toDetail)`.
 * Expects: a well-formed request.
 * Output: the reply envelope (never throws); `message` only when
 * `toDetail` returns a text.
 */
async function runHandler(handlers: Record<string, Handler>, req: RpcRequest, toCode: (e: unknown) => string, toDetail?: ToDetail): Promise<RpcReply> {
  const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
  if (!handler) return { id: req.id, ok: false, error: 'UNKNOWN_METHOD' };
  try {
    return { id: req.id, ok: true, value: await handler(req.params) };
  } catch (e) {
    const message = toDetail?.(e);
    return message === undefined ? { id: req.id, ok: false, error: toCode(e) } : { id: req.id, ok: false, error: toCode(e), message };
  }
}

/**
 * Random request id.
 *
 * Call: `newId()`.
 * Expects: Web Crypto (`crypto.randomUUID`).
 * Output: a UUID string.
 */
function newId(): string {
  return crypto.randomUUID();
}
