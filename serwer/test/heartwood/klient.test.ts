import { describe, expect, it, vi } from 'vitest';
import { intClient, IntError } from '../../src/heartwood/klient.js';

const setup = (res: Response = new Response(null, { status: 204 })) => {
  const fetch = vi.fn(async () => res);
  const sign = vi.fn(async () => ({ authorization: 'SIG' }));
  const c = intClient({ url: 'https://hw.test', region: 'eu-west-1', fetch: fetch as never, sign });
  return { c, fetch, sign };
};

describe('intClient', () => {
  it('puts work state with signed headers', async () => {
    const { c, fetch, sign } = setup();
    await c.putWork('pilot', 'cognifly:zad_0123456789ab', { writer: 's1', closed: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hw.test/int/orgs/pilot/work/cognifly%3Azad_0123456789ab');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"writer":"s1","closed":false}');
    expect((init.headers as Record<string, string>).authorization).toBe('SIG');
    expect(sign).toHaveBeenCalledOnce();
  });

  it('throws IntError with the body code', async () => {
    const { c } = setup(new Response('{"code":"BUSY"}', { status: 409 }));
    const err = await c.putOrg('o', 'N').catch((e) => e);
    expect(err).toBeInstanceOf(IntError);
    expect(err).toMatchObject({ code: 'BUSY', status: 409 });
  });

  it('falls back to HTTP_<status>', async () => {
    const { c } = setup(new Response('oops', { status: 500 }));
    await expect(c.putOrg('o', 'N')).rejects.toMatchObject({ code: 'HTTP_500', status: 500 });
  });

  it('encodes path segments', async () => {
    const { c, fetch } = setup();
    await c.putTopic('o/1', 'w#2', 't');
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://hw.test/int/orgs/o%2F1/workspaces/w%232/topics/t');
  });

  it('puts grants, people, workspaces', async () => {
    const { c, fetch } = setup();
    await c.putGrant('o', 'w', 's', 'write');
    await c.putPerson('o', 's', true);
    await c.putWorkspace('o', 'w', 'Name');
    const bodies = fetch.mock.calls.map((x) => (x as unknown as [string, RequestInit])[1].body);
    expect(bodies).toEqual(['{"right":"write"}', '{"isAdmin":true}', '{"name":"Name"}']);
  });

  it('gets work files, merging pages and signing GETs', async () => {
    const page = (n: number, cursor?: string) => new Response(JSON.stringify({
      writer: 's1', closed: false, hiddenLocks: n === 1 ? 2 : 0,
      locks: n === 1 ? [{ space: 'ws:a', path: 'x', folder: false, by: 's1', at: 't', ws: 'a', workId: 'w', writer: 's1' }] : [],
      versions: [{ space: 'ws:a', path: `f${n}`, seq: n }], ...(cursor ? { cursor } : {}),
    }), { status: 200 });
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(1, 'c1')).mockResolvedValueOnce(page(2));
    const sign = vi.fn(async () => ({ authorization: 'SIG' }));
    const c = intClient({ url: 'https://hw.test', region: 'r', fetch: fetch as never, sign });
    const r = await c.getWorkFiles('pilot', 'cognifly:zad_0123456789ab');
    const urls = fetch.mock.calls.map((x) => (x as unknown as [string])[0]);
    expect(urls).toEqual([
      'https://hw.test/int/orgs/pilot/work/cognifly%3Azad_0123456789ab/files',
      'https://hw.test/int/orgs/pilot/work/cognifly%3Azad_0123456789ab/files?cursor=c1']);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('GET');
    expect(r.versions.map((v) => v.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ writer: 's1', hiddenLocks: 2 });
    expect(r.locks).toHaveLength(1);
    expect(r.cursor).toBeUndefined();
  });

  it('stops after 20 pages', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      writer: null, closed: false, locks: [], hiddenLocks: 0, versions: [], cursor: 'more',
    })));
    const c = intClient({ url: 'https://hw.test', region: 'r', fetch: fetch as never, sign: async () => ({}) });
    await c.getWorkFiles('o', 'w');
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it('throws IntError on a failed GET', async () => {
    const { c } = setup(new Response('{"code":"FORBIDDEN"}', { status: 403 }));
    await expect(c.getWorkFiles('o', 'w')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});
