// Client of Heartwood's IAM-authenticated integration API (`/int/...`).
// Requests are SigV4-signed for `execute-api`; no credentials are logged.
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

/** Request to sign. */
export type SignReq = {
  method: string; url: string; headers: Record<string, string>; body: string;
};
/** Returns the headers (signature included) to send for a request. */
export type Signer = (req: SignReq) => Promise<Record<string, string>>;

/** Access right of a person in a workspace. */
export type Right = 'none' | 'read' | 'write' | 'admin';

/** A live lock of a work, tagged with its space (`ws:..`/`user:..`). */
export type WorkFileLock = {
  space: string; ws: string; path: string; workId: string; folder: boolean;
  by: string; at: string; writer: string | null;
};

/** A version saved under a work, tagged with its space and path. */
export type WorkFileVersion = {
  space: string; path: string; seq: number; versionId?: string; sha256?: string;
  size?: number; author: string; workId?: string; at: string;
  kind: 'put' | 'restore' | 'move' | 'delete'; fromSeq?: number; fromPath?: string;
};

/** Files of one work (Heartwood contract 3.5); `sub`s as identities. */
export type WorkFilesResponse = {
  writer: string | null; closed: boolean; locks: WorkFileLock[];
  hiddenLocks: number; versions: WorkFileVersion[]; cursor?: string;
};

/** Most version pages `getWorkFiles` fetches (100 versions each). */
export const MAX_WORK_FILE_PAGES = 20;

/** Heartwood integration API (idempotent PUTs and work-files GET). */
export interface IntClient {
  getWorkFiles(org: string, workId: string): Promise<WorkFilesResponse>;
  putWork(org: string, workId: string, s: { writer: string | null; closed: boolean }): Promise<void>;
  putOrg(org: string, name: string): Promise<void>;
  putPerson(org: string, sub: string, isAdmin: boolean): Promise<void>;
  putWorkspace(org: string, ws: string, name: string): Promise<void>;
  putTopic(org: string, ws: string, topic: string): Promise<void>;
  putGrant(org: string, ws: string, sub: string, right: Right): Promise<void>;
}

/** Failure of an integration call. */
export class IntError extends Error {
  constructor(public status: number, public code: string) {
    super(`Heartwood ${status} ${code}`);
    this.name = 'IntError';
  }
}

/**
 * Builds the default SigV4 signer (service `execute-api`).
 *
 * Call: `sigV4Signer('eu-west-1')`.
 * Expects: AWS credentials resolvable by the default provider chain.
 * Output: a `Signer` returning the signed headers.
 */
export function sigV4Signer(region: string): Signer {
  const signer = new SignatureV4({
    service: 'execute-api', region, sha256: Sha256, credentials: defaultProvider(),
  });
  return async (r) => {
    const u = new URL(r.url);
    const query = Object.fromEntries(u.searchParams);
    const signed = await signer.sign({
      method: r.method, protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      query, body: r.body, headers: { ...r.headers, host: u.host },
    });
    return signed.headers as Record<string, string>;
  };
}

/** Sends one signed request: `(method, url, body?)` -> raw response. */
export type SignedFetch = (method: string, url: string, body?: string) => Promise<Response>;

/**
 * Builds a SigV4-signing fetch shared by the `/int` clients.
 *
 * Call: `signedFetch({ region })`; `fetch` and `sign` are for tests.
 * Expects: the API region.
 * Output: a `SignedFetch`; a body is sent as JSON, without a body the
 * empty string is signed. Any status is returned as is; network and
 * signing errors propagate.
 */
export function signedFetch(o: { region: string; fetch?: typeof fetch; sign?: Signer }): SignedFetch {
  const doFetch = o.fetch ?? fetch;
  const sign = o.sign ?? sigV4Signer(o.region);
  return async (method, url, body) => {
    const base: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    const signed = await sign({ method, url, headers: base, body: body ?? '' });
    const headers = { ...base, ...signed };
    return doFetch(url, body === undefined ? { method, headers } : { method, headers, body });
  };
}

/**
 * Reads the error code of a failed response.
 *
 * Call: `await errorOf(res)`.
 * Expects: a non-2xx response.
 * Output: an `IntError` with the body's `{code}`, else `HTTP_<status>`.
 */
async function errorOf(res: Response): Promise<IntError> {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : `HTTP_${res.status}`;
  return new IntError(res.status, code);
}

/**
 * Creates the integration client.
 *
 * Call: `intClient({ url, region })`; `fetch` and `sign` are for tests.
 * Expects: the API base url (no trailing path) and its region.
 * Output: an `IntClient`; failed calls throw `IntError`.
 */
export function intClient(o: {
  url: string; region: string; fetch?: typeof fetch; sign?: Signer;
}): IntClient {
  const send = signedFetch(o);
  const base = o.url.replace(/\/+$/, '');
  const e = encodeURIComponent;

  /**
   * Sends one signed PUT under `/int`.
   *
   * Call: `await put("/orgs/x", { name })`.
   * Expects: an encoded path and a JSON-serialisable payload.
   * Output: resolves on 2xx; otherwise throws `IntError`.
   */
  async function put(path: string, payload: object): Promise<void> {
    const res = await send('PUT', `${base}/int${path}`, JSON.stringify(payload));
    if (!res.ok) throw await errorOf(res);
  }

  /**
   * Sends one signed GET under `/int` and parses the JSON answer.
   *
   * Call: `await get<T>("/orgs/x/work/y/files?cursor=c")`.
   * Expects: an encoded path (with optional query).
   * Output: the parsed body; non-2xx throws `IntError`.
   */
  async function get<T>(path: string): Promise<T> {
    const res = await send('GET', `${base}/int${path}`);
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  }

  /**
   * Reads the files of a work, merging version pages.
   *
   * Call: `await getWorkFiles(org, workId)`.
   * Expects: org and work id (encoded here).
   * Output: first page's writer/closed/locks/hiddenLocks, versions of
   * up to `MAX_WORK_FILE_PAGES` pages; `cursor` left only if truncated.
   */
  async function getWorkFiles(org: string, workId: string): Promise<WorkFilesResponse> {
    const path = `/orgs/${e(org)}/work/${e(workId)}/files`;
    const first = await get<WorkFilesResponse>(path);
    const out: WorkFilesResponse = { ...first, versions: [...first.versions] };
    for (let n = 1; out.cursor && n < MAX_WORK_FILE_PAGES; n++) {
      const page = await get<WorkFilesResponse>(`${path}?cursor=${e(out.cursor)}`);
      out.versions.push(...page.versions);
      if (page.cursor) out.cursor = page.cursor; else delete out.cursor;
    }
    return out;
  }

  return {
    getWorkFiles,
    putWork: (org, id, s) => put(`/orgs/${e(org)}/work/${e(id)}`, s),
    putOrg: (org, name) => put(`/orgs/${e(org)}`, { name }),
    putPerson: (org, sub, isAdmin) => put(`/orgs/${e(org)}/people/${e(sub)}`, { isAdmin }),
    putWorkspace: (org, ws, name) => put(`/orgs/${e(org)}/workspaces/${e(ws)}`, { name }),
    putTopic: (org, ws, t) => put(`/orgs/${e(org)}/workspaces/${e(ws)}/topics/${e(t)}`, {}),
    putGrant: (org, ws, sub, right) =>
      put(`/orgs/${e(org)}/workspaces/${e(ws)}/grants/${e(sub)}`, { right }),
  };
}
