import { describe, expect, it, vi } from 'vitest';
import { Controller, waitingCount, type Ports } from '../src/logic/controller.js';
import { NetworkError } from '../src/logic/errors.js';
import type { FetchFn } from '../src/logic/http.js';
import { memoryStore } from '../src/logic/storage.js';
import type { InboxView } from '../src/windows/protocol.js';
import { memoryVault } from './helpers.js';

const NOW = 50_000_000;
const id = (n: number) => `zad_${String(n).padStart(12, '0')}`;
const task = (n: number, stan = 'nowe') => ({ id: id(n), firma: 'pilot', zdarzenieId: 'e', kandydaci: ['michal'], stan, utworzono: '', opis: `Review PR #${n}` });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const goodSession = JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 3_600_000, email: 'm@x.pl' });

/** Fake backend: routes by URL; `inbox` is mutable between polls. */
function setup(opts: { session?: string | null; inbox?: unknown[] } = {}) {
  const state = { inbox: opts.inbox ?? [], offline: false, cognito: [] as unknown[] };
  const fetch: FetchFn = vi.fn(async (url: string, init: RequestInit) => {
    if (state.offline) throw new TypeError('offline');
    if (url.startsWith('https://cognito-idp')) {
      state.cognito.push(JSON.parse(String(init.body)));
      const target = (init.headers as Record<string, string>)['X-Amz-Target'];
      if (target?.endsWith('InitiateAuth')) return json(200, { ChallengeName: 'EMAIL_OTP', Session: 'S' });
      const code = (JSON.parse(String(init.body)) as { ChallengeResponses: { EMAIL_OTP_CODE: string } }).ChallengeResponses.EMAIL_OTP_CODE;
      if (code !== '123456') return json(400, { __type: 'CodeMismatchException' });
      return json(200, { AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R', ExpiresIn: 3600 } });
    }
    if (url.endsWith('/skrzynka')) return json(200, { zadania: state.inbox });
    if (url.endsWith('/biore')) return json(409, { kod: 'ZAJETE', wlasciciel: 'szymon' });
    return json(404, { kod: 'NIE_ZNALEZIONO' });
  });
  const views: InboxView[] = [];
  const ports: Ports = {
    store: memoryStore(),
    vault: memoryVault(opts.session === undefined ? goodSession : opts.session),
    fetch,
    notify: vi.fn(async () => undefined),
    render: (v) => void views.push(v),
    showWindow: vi.fn(async () => undefined),
    now: () => NOW,
  };
  return { c: new Controller(ports), ports, state, views };
}

describe('Controller', () => {
  it('without a session opens the login window and does not poll', async () => {
    const { c, ports } = setup({ session: null });
    expect((await c.start()).loggedIn).toBe(false);
    expect(ports.showWindow).toHaveBeenCalledWith('login');
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it('first poll counts tasks without notifying; a new task notifies once with opis only', async () => {
    const { c, ports, state } = setup({ inbox: [task(1), task(2, 'wziete')] });
    const v = await c.start();
    expect(waitingCount(v)).toBe(1);
    expect(ports.notify).not.toHaveBeenCalled();

    state.inbox = [task(1), task(3)];
    await c.poll();
    await c.poll();
    expect(ports.notify).toHaveBeenCalledTimes(1);
    expect(ports.notify).toHaveBeenCalledWith('CogniFly — nowe zadanie', 'Review PR #3');
  });

  it('offline keeps tasks and session, marks offline, recovers', async () => {
    const { c, ports, state } = setup({ inbox: [task(1)] });
    await c.start();
    state.offline = true;
    const v = await c.poll();
    expect(v).toMatchObject({ loggedIn: true, offline: true });
    expect(v.tasks).toHaveLength(1);
    expect(await ports.vault.read()).not.toBeNull();
    state.offline = false;
    expect((await c.poll()).offline).toBe(false);
  });

  it('login: wrong code keeps the pending login, right code stores session and polls', async () => {
    const { c, ports } = setup({ session: null, inbox: [task(1)] });
    await c.start();
    const h = c.handlers();
    expect(await h['login.sendCode']!({ email: 'm@x.pl' })).toEqual({ email: 'm@x.pl' });
    await expect(h['login.confirm']!({ code: '000000' })).rejects.toMatchObject({ code: 'WRONG_CODE' });
    expect(await h['login.confirm']!({ code: '123456' })).toEqual({ email: 'm@x.pl' });
    expect(JSON.parse((await ports.vault.read())!)).toMatchObject({ accessToken: 'A', email: 'm@x.pl' });
    expect(c.current().loggedIn).toBe(true);
  });

  it('confirm without sendCode fails with NO_PENDING_LOGIN', async () => {
    const { c } = setup({ session: null });
    await expect(c.handlers()['login.confirm']!({ code: '123456' })).rejects.toMatchObject({ code: 'NO_PENDING_LOGIN' });
  });

  it('take returns BUSY with the owner', async () => {
    const { c } = setup({ inbox: [task(1)] });
    await c.start();
    expect(await c.handlers()['inbox.take']!({ id: id(1) })).toEqual({ status: 'BUSY', owner: 'szymon' });
  });

  it('changing the user pool logs out; invalid settings are rejected', async () => {
    const { c, ports } = setup({ inbox: [] });
    await c.start();
    const h = c.handlers();
    const { config } = (await h['config.get']!({})) as { config: Record<string, string> };
    expect(await h['config.save']!({ config: { ...config, region: 'zly' } })).toEqual({ ok: false, field: 'region' });
    expect(await h['config.save']!({ config: { ...config, clientId: 'innyklient' } })).toEqual({ ok: true });
    expect(await ports.vault.read()).toBeNull();
    expect(c.current().loggedIn).toBe(false);
  });

  it('logout clears the vault and the view', async () => {
    const { c, ports } = setup({ inbox: [task(1)] });
    await c.start();
    await c.logout();
    expect(await ports.vault.read()).toBeNull();
    expect(c.current()).toMatchObject({ loggedIn: false, tasks: [], email: null });
  });

  it('a network error surfaces as NetworkError to the login window', async () => {
    const { c, state } = setup({ session: null });
    state.offline = true;
    await expect(c.handlers()['login.sendCode']!({ email: 'm@x.pl' })).rejects.toBeInstanceOf(NetworkError);
  });
});
