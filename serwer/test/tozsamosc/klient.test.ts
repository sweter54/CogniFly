import { describe, expect, it, vi } from 'vitest';
import { identityClient, IdentityError } from '../../src/tozsamosc/klient.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const person = (sub: string, status = 'active') => ({ org: 'pilot', sub, email: `${sub}@x.pl`, role: 'member', status });

const setup = (...pages: Response[]) => {
  const fetch = vi.fn();
  for (const p of pages) fetch.mockResolvedValueOnce(p);
  const sign = vi.fn(async () => ({ authorization: 'SIG' }));
  const c = identityClient({ url: 'https://id.test/', region: 'eu-central-1', fetch: fetch as never, sign });
  return { c, fetch, sign };
};

describe('identityClient', () => {
  it('people_follows_cursor_and_signs', async () => {
    const { c, fetch, sign } = setup(
      json({ items: [person('s1')], cursor: 'c/1' }),
      json({ items: [person('s2', 'removed')] }),
    );
    const people = await c.people('pilot');
    expect(people).toEqual([
      { sub: 's1', email: 's1@x.pl', role: 'member', status: 'active' },
      { sub: 's2', email: 's2@x.pl', role: 'member', status: 'removed' },
    ]);
    const urls = fetch.mock.calls.map((x) => (x as unknown as [string])[0]);
    expect(urls).toEqual([
      'https://id.test/int/orgs/pilot/people',
      'https://id.test/int/orgs/pilot/people?cursor=c%2F1',
    ]);
    for (const call of fetch.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).authorization).toBe('SIG');
    }
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1]).toEqual([
      { method: 'GET', url: 'https://id.test/int/orgs/pilot/people?cursor=c%2F1', headers: {}, body: '' },
    ]);
  });

  it('orgs_follows_cursor', async () => {
    const { c, fetch } = setup(json({ items: [{ org: 'pilot' }], cursor: 'n' }), json({ items: [{ org: 'b' }] }));
    expect(await c.orgs()).toEqual(['pilot', 'b']);
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe('https://id.test/int/orgs?cursor=n');
  });

  it('non_2xx_throws_identity_error', async () => {
    const { c } = setup(json({ items: [person('s1')], cursor: 'c' }), new Response('no', { status: 503 }));
    const err = await c.people('pilot').catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect(err.status).toBe(503);
  });

  it('bad_page_shape_throws_identity_error', async () => {
    const { c } = setup(json({ nope: true }));
    await expect(c.orgs()).rejects.toBeInstanceOf(IdentityError);
  });
});
