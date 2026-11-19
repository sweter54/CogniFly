// Client of the Identity service's IAM-authenticated API (`/int/...`).
// Requests are SigV4-signed for `execute-api`; no credentials are logged.
import { signedFetch, type Signer } from '../heartwood/klient.js';

/** A member of a company as Identity sees it (`name` is dropped). */
export type IdentityPerson = {
  sub: string; email: string; role: 'admin' | 'member'; status: 'active' | 'removed';
};

/** Identity integration API (read-only). */
export interface IdentityClient {
  orgs(): Promise<string[]>;
  people(org: string): Promise<IdentityPerson[]>;
}

/** Failure of an Identity call: non-2xx status or a bad page shape. */
export class IdentityError extends Error {
  constructor(public status: number) {
    super(`Tożsamość ${status}`);
    this.name = 'IdentityError';
  }
}

/** One page of a listing. */
type Page = { items: unknown[]; cursor?: string };

/**
 * Checks the shape of a listing page.
 *
 * Call: `isPage(body)`.
 * Expects: a parsed JSON body.
 * Output: true for `{items: [...], cursor?: string}`.
 */
function isPage(b: unknown): b is Page {
  const p = b as Page | null;
  return Array.isArray(p?.items) && (p.cursor === undefined || typeof p.cursor === 'string');
}

/**
 * Reads the company id of an `/int/orgs` item.
 *
 * Call: `orgIdOf({ org: 'pilot' })` -> `'pilot'`.
 * Expects: an item (an object with `org`, or a bare string).
 * Output: the id; throws `IdentityError(502)` for any other shape.
 */
function orgIdOf(it: unknown): string {
  const id = typeof it === 'string' ? it : (it as { org?: unknown } | null)?.org;
  if (typeof id !== 'string' || id === '') throw new IdentityError(502);
  return id;
}

/**
 * Reads a person of an `/int/orgs/{org}/people` item.
 *
 * Call: `personOf(item)`.
 * Expects: an item `{sub, email, role, status, ...}`.
 * Output: the person without extra fields; throws `IdentityError(502)`
 * when a field is missing or out of range.
 */
function personOf(it: unknown): IdentityPerson {
  const p = (it ?? {}) as Record<string, unknown>;
  const ok = typeof p.sub === 'string' && p.sub !== '' && typeof p.email === 'string'
    && (p.role === 'admin' || p.role === 'member')
    && (p.status === 'active' || p.status === 'removed');
  if (!ok) throw new IdentityError(502);
  return { sub: p.sub, email: p.email, role: p.role, status: p.status } as IdentityPerson;
}

/**
 * Creates the Identity client.
 *
 * Call: `identityClient({ url, region })`; `fetch`, `sign` for tests.
 * Expects: the API base url (no trailing path) and its region.
 * Output: an `IdentityClient` that follows `cursor` until absent;
 * non-2xx throws `IdentityError(status)`, a bad body `IdentityError(502)`.
 */
export function identityClient(o: {
  url: string; region: string; fetch?: typeof fetch; sign?: Signer;
}): IdentityClient {
  const send = signedFetch(o);
  const base = o.url.replace(/\/+$/, '');

  /**
   * Reads all items of a paged `/int` listing.
   *
   * Call: `await all('/orgs/pilot/people')`.
   * Expects: an encoded path without query.
   * Output: items of every page in order; errors as `identityClient`.
   */
  async function all(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const res = await send('GET', `${base}/int${path}${query}`);
      if (!res.ok) throw new IdentityError(res.status);
      const page: unknown = await res.json().catch(() => null);
      if (!isPage(page)) throw new IdentityError(502);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return items;
  }

  return {
    orgs: async () => (await all('/orgs')).map(orgIdOf),
    people: async (org) => (await all(`/orgs/${encodeURIComponent(org)}/people`)).map(personOf),
  };
}
