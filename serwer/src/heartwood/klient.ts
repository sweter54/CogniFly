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

/** Heartwood integration API (all calls are idempotent PUTs). */
export interface IntClient {
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
  const doFetch = o.fetch ?? fetch;
  const sign = o.sign ?? sigV4Signer(o.region);
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
    const url = `${base}/int${path}`;
    const body = JSON.stringify(payload);
    const baseHeaders = { 'content-type': 'application/json' };
    const headers = await sign({ method: 'PUT', url, headers: baseHeaders, body });
    const res = await doFetch(url, { method: 'PUT', headers: { ...baseHeaders, ...headers }, body });
    if (!res.ok) throw await errorOf(res);
  }

  return {
    putWork: (org, id, s) => put(`/orgs/${e(org)}/work/${e(id)}`, s),
    putOrg: (org, name) => put(`/orgs/${e(org)}`, { name }),
    putPerson: (org, sub, isAdmin) => put(`/orgs/${e(org)}/people/${e(sub)}`, { isAdmin }),
    putWorkspace: (org, ws, name) => put(`/orgs/${e(org)}/workspaces/${e(ws)}`, { name }),
    putTopic: (org, ws, t) => put(`/orgs/${e(org)}/workspaces/${e(ws)}/topics/${e(t)}`, {}),
    putGrant: (org, ws, sub, right) =>
      put(`/orgs/${e(org)}/workspaces/${e(ws)}/grants/${e(sub)}`, { right }),
  };
}
