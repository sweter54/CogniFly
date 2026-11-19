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
});
