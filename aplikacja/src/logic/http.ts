// The single JSON-over-HTTP helper used by both the Cognito and the
// CogniFly API clients. The fetch function is injected so tests can
// fake it and the app can pass the Tauri HTTP plugin's fetch.
import { NetworkError } from './errors.js';

/** Fetch-compatible function (global fetch or `@tauri-apps/plugin-http`). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Status and parsed body of a response. */
export interface JsonResponse { status: number; json: unknown }

/** Default request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Options of one JSON request. */
export interface JsonRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Sends one request and parses the JSON answer.
 *
 * Call: `requestJson(fetch, url, { method, headers, body })`.
 * Expects: `body` (if any) JSON-serialisable; it is sent with the
 * `Content-Type: application/json` header unless one is given.
 * Output: `{ status, json }`; `json` is `{}` when a non-2xx response
 * has no JSON body.
 * Throws: `NetworkError` on connection failure or timeout, and also
 * when a 2xx response is not JSON (a proxy or captive portal page).
 */
export async function requestJson(fetchFn: FetchFn, url: string, req: JsonRequest): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...req.headers };
  if (req.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new NetworkError();
  }
  return { status: response.status, json: await parseBody(response) };
}

/**
 * Parses a response body as JSON.
 *
 * Call: `parseBody(response)`.
 * Expects: an unread response.
 * Output: the parsed value; `{}` for an unparsable non-2xx body.
 * Throws: `NetworkError` when a 2xx body is not JSON.
 */
async function parseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new NetworkError();
    return {};
  }
}

/**
 * Reads a string field from an unknown JSON object.
 *
 * Call: `stringField(json, 'kod')`.
 * Expects: anything as `json`.
 * Output: the field when it is a string, otherwise `undefined`.
 */
export function stringField(json: unknown, name: string): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const value = (json as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
