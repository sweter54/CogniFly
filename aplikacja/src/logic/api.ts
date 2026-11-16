// Client of the CogniFly HTTP API (Cognito JWT + X-Cognifly-Firma).
import {
  isRepo, TASK_ID_PATTERN, USER_SETTABLE_STATES, type MeResponse, type Person, type Task, type UserSettableState,
} from '@cognifly/wspolne/api';
import type { AppConfig } from './config.js';
import { ApiError, LoginRequiredError } from './errors.js';
import { requestJson, stringField, type FetchFn, type JsonResponse } from './http.js';
import type { SessionManager } from './session.js';

/** The person's id in one company (from `GET /ja`). */
export type Membership = MeResponse['firmy'][number];

/** Outcome of "biorę". */
export type TakeResult =
  | { status: 'TAKEN'; task: Task }
  | { status: 'BUSY'; owner: string };

/** Talks to the API on behalf of the logged-in user. */
export class ApiClient {
  /**
   * Call: `new ApiClient(config, session, fetch)`.
   * Expects: a validated config and the session manager.
   * Output: a client; no request is made yet.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly session: SessionManager,
    private readonly fetchFn: FetchFn,
  ) {}

  /**
   * Who the logged-in person is.
   *
   * Call: `await api.me()` (`GET /ja`).
   * Expects: a session; no company needs to be chosen yet.
   * Output: the person's companies with their id in each (malformed
   * entries dropped).
   * Throws: `ApiError` (403 `BRAK_DOSTEPU` for unknown people),
   * session errors.
   */
  async me(): Promise<Membership[]> {
    const r = await this.call('GET', '/ja');
    if (r.status !== 200) throw apiError(r);
    const list = (r.json as { firmy?: unknown }).firmy;
    return Array.isArray(list) ? list.filter(isMembership) : [];
  }

  /**
   * People of the company (reviewer picker).
   *
   * Call: `await api.people()` (`GET /osoby`).
   * Expects: a session.
   * Output: well-formed people (`osoba`, optional `github`).
   * Throws: `ApiError`, session errors.
   */
  async people(): Promise<Person[]> {
    const r = await this.call('GET', '/osoby');
    if (r.status !== 200) throw apiError(r);
    const list = (r.json as { osoby?: unknown }).osoby;
    return Array.isArray(list) ? list.filter(isPerson) : [];
  }

  /**
   * Asks colleagues to review a PR.
   *
   * Call: `await api.requestReview(repo, pr, reviewers)` (`POST /recenzje`).
   * Expects: `owner/name`, a positive PR number, 1+ person ids.
   * Output: the created "Prośba o recenzję" task.
   * Throws: `ApiError(400, 'ZLE_REPO' | 'ZLY_PR' | 'ZLI_RECENZENCI')`
   * locally; server codes (`BRAK_PR`, `PR_ZAMKNIETY`, …) otherwise.
   */
  async requestReview(repo: string, pr: number, reviewers: string[]): Promise<Task> {
    if (!isRepo(repo)) throw new ApiError(400, 'ZLE_REPO');
    if (!Number.isInteger(pr) || pr < 1) throw new ApiError(400, 'ZLY_PR');
    if (!reviewers.length) throw new ApiError(400, 'ZLI_RECENZENCI');
    const r = await this.call('POST', '/recenzje', { repo, pr, recenzenci: reviewers });
    if (r.status !== 200) throw apiError(r);
    return taskFrom(r);
  }

  /**
   * Lists the user's tasks.
   *
   * Call: `await api.inbox()` (`GET /skrzynka`).
   * Expects: a session.
   * Output: well-formed tasks only (malformed entries are dropped).
   * Throws: `ApiError`, `LoginRequiredError`, `NetworkError`.
   */
  async inbox(): Promise<Task[]> {
    const r = await this.call('GET', '/skrzynka');
    if (r.status !== 200) throw apiError(r);
    const list = (r.json as { zadania?: unknown }).zadania;
    return Array.isArray(list) ? list.filter(isTask) : [];
  }

  /**
   * Takes a task ("biorę").
   *
   * Call: `await api.take(id)` (`POST /zadania/{id}/biore`).
   * Expects: a task id; an invalid id fails without a request.
   * Output: `TAKEN` with the task, or `BUSY` with the owner (409).
   * Throws: `ApiError` (404 `NIE_ZNALEZIONO`, 403 ...), session errors.
   */
  async take(id: string): Promise<TakeResult> {
    const r = await this.call('POST', `/zadania/${checkedId(id)}/biore`);
    if (r.status === 200) return { status: 'TAKEN', task: taskFrom(r) };
    if (r.status === 409) return { status: 'BUSY', owner: stringField(r.json, 'wlasciciel') ?? '?' };
    throw apiError(r);
  }

  /**
   * Changes the state of the user's task.
   *
   * Call: `await api.setState(id, state)` (`POST /zadania/{id}/stan`).
   * Expects: a valid id and one of `USER_SETTABLE_STATES`.
   * Output: the updated task.
   * Throws: `ApiError('ZLY_STAN')` locally for other states; API and
   * session errors as in `take`.
   */
  async setState(id: string, state: UserSettableState): Promise<Task> {
    if (!(USER_SETTABLE_STATES as readonly string[]).includes(state)) throw new ApiError(400, 'ZLY_STAN');
    const r = await this.call('POST', `/zadania/${checkedId(id)}/stan`, { stan: state });
    if (r.status !== 200) throw apiError(r);
    return taskFrom(r);
  }

  /**
   * Sends an authorised request, retrying once after a 401.
   *
   * Call: `await this.call(method, path, body?)`.
   * Expects: a path starting with `/`.
   * Output: the response of the (possibly retried) request.
   * Throws: `LoginRequiredError` when a refreshed token is still
   * rejected; errors of `SessionManager` and `requestJson`.
   */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<JsonResponse> {
    const first = await this.send(method, path, await this.session.accessToken(), body);
    if (first.status !== 401) return first;
    const retry = await this.send(method, path, await this.session.forceRefresh(), body);
    if (retry.status === 401) throw new LoginRequiredError();
    return retry;
  }

  /**
   * Sends one request with auth and company headers.
   *
   * Call: `await this.send(method, path, token, body?)`.
   * Expects: a valid access token.
   * Output: the raw JSON response.
   */
  private send(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<JsonResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (this.config.company) headers['X-Cognifly-Firma'] = this.config.company;
    return requestJson(this.fetchFn, this.config.apiUrl + path, { method, headers, body });
  }
}

/**
 * Validates a task id before it is put into a URL.
 *
 * Call: `checkedId(id)`.
 * Expects: any string.
 * Output: the same id when it matches `TASK_ID_PATTERN`.
 * Throws: `ApiError(404, 'NIE_ZNALEZIONO')` otherwise.
 */
function checkedId(id: string): string {
  if (!TASK_ID_PATTERN.test(id)) throw new ApiError(404, 'NIE_ZNALEZIONO');
  return id;
}

/**
 * Extracts `zadanie` from a 200 response.
 *
 * Call: `taskFrom(response)`.
 * Expects: a 200 response of `/biore` or `/stan`.
 * Output: the task.
 * Throws: `ApiError(status, 'BAD_RESPONSE')` when it is malformed.
 */
function taskFrom(r: JsonResponse): Task {
  const task = (r.json as { zadanie?: unknown }).zadanie;
  if (!isTask(task)) throw new ApiError(r.status, 'BAD_RESPONSE');
  return task;
}

/**
 * Builds an `ApiError` from an error response.
 *
 * Call: `apiError(response)`.
 * Expects: a non-success response.
 * Output: error with the body's `kod` or `HTTP_<status>`.
 */
function apiError(r: JsonResponse): ApiError {
  return new ApiError(r.status, stringField(r.json, 'kod') ?? `HTTP_${r.status}`);
}

/**
 * Checks the fields the app relies on.
 *
 * Call: `isTask(x)`.
 * Expects: anything from the network.
 * Output: `true` when `id`, `stan` and `opis` are strings and `id`
 * matches `TASK_ID_PATTERN`.
 */
export function isTask(x: unknown): x is Task {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  return typeof t.id === 'string' && TASK_ID_PATTERN.test(t.id)
    && typeof t.stan === 'string' && typeof t.opis === 'string';
}

/**
 * Checks one `GET /ja` entry.
 *
 * Call: `isMembership(x)`.
 * Expects: anything from the network.
 * Output: `true` when `firma` and `osoba` are non-empty strings.
 */
function isMembership(x: unknown): x is Membership {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return typeof m.firma === 'string' && m.firma !== '' && typeof m.osoba === 'string' && m.osoba !== '';
}

/**
 * Checks one `GET /osoby` entry.
 *
 * Call: `isPerson(x)`.
 * Expects: anything from the network.
 * Output: true when `osoba` is a non-empty string and `github`, if
 * present, is a string.
 */
function isPerson(x: unknown): x is Person {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return typeof p.osoba === 'string' && p.osoba !== '' && (p.github === undefined || typeof p.github === 'string');
}
