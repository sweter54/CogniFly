import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/logic/config.js';
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
  const state = { inbox: opts.inbox ?? [], offline: false, cognito: [] as unknown[], firmy: [{ firma: 'pilot', osoba: 'michal' }] };
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
    if (url.endsWith('/ja')) return json(200, { firmy: state.firmy });
    if (url.endsWith('/osoby')) return json(200, { osoby: [{ osoba: 'ania' }, { osoba: 'michal' }] });
    if (url.endsWith('/recenzje')) return json(200, { zadanie: task(9) });
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
    showScreen: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    pickFolder: vi.fn(async (): Promise<string | null> => '/Users/m/repo'),
    now: () => NOW,
  };
  return { c: new Controller(ports), ports, state, views };
}

describe('Controller', () => {
  it('without a session opens the login window and does not poll', async () => {
    const { c, ports } = setup({ session: null });
    expect((await c.start()).loggedIn).toBe(false);
    expect(ports.showScreen).toHaveBeenCalledWith('login');
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

  it('a revoked session switches to the login screen and clears the vault', async () => {
    const { ports } = setup({ session: JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW, email: 'm@x.pl' }) });
    const revoked: FetchFn = vi.fn(async (url: string) => json(url.includes('cognito') ? 400 : 401, { __type: 'NotAuthorizedException' }));
    const c = new Controller({ ...ports, fetch: revoked });
    expect((await c.start()).loggedIn).toBe(false);
    expect(ports.showScreen).toHaveBeenCalledWith('login');
    expect(await ports.vault.read()).toBeNull();
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

  it('loads who I am; a single company is chosen automatically', async () => {
    const { c, ports, state } = setup({ inbox: [] });
    state.firmy = [{ firma: 'acme', osoba: 'm.roszkowski' }];
    await c.start();
    expect(c.current().osoba).toBe('m.roszkowski');
    expect(JSON.parse(ports.store.getItem('cognifly.config')!).company).toBe('acme');
    expect(await c.handlers()['account.get']!({})).toEqual({
      email: 'm@x.pl', osoba: 'm.roszkowski', company: 'acme', companies: [{ firma: 'acme', osoba: 'm.roszkowski' }],
    });
  });

  it('switches company only to one the person belongs to', async () => {
    const { c, state, ports } = setup({ inbox: [] });
    state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
    await c.start();
    const h = c.handlers();
    await expect(h['config.setCompany']!({ company: 'obca' })).rejects.toMatchObject({ code: 'BAD_COMPANY' });
    expect(await h['config.setCompany']!({ company: 'acme' })).toEqual({ ok: true });
    expect(c.current().osoba).toBe('mr');
    await c.poll();
    const last = (ports.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect((last[1] as RequestInit & { headers: Record<string, string> }).headers['X-Cognifly-Firma']).toBe('acme');
  });

  it('logout (rpc) clears the vault and the view', async () => {
    const { c, ports } = setup({ inbox: [task(1)] });
    await c.start();
    expect(await c.handlers()['session.logout']!({})).toEqual({ ok: true });
    expect(await ports.vault.read()).toBeNull();
    expect(c.current()).toMatchObject({ loggedIn: false, tasks: [], email: null });
  });

  it('a network error surfaces as NetworkError to the login window', async () => {
    const { c, state } = setup({ session: null });
    state.offline = true;
    await expect(c.handlers()['login.sendCode']!({ email: 'm@x.pl' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('an inbox answer arriving after logout is dropped (no old tasks, no seen-set)', async () => {
    const { c, ports, state } = setup({ inbox: [task(1)] });
    await c.start();
    state.inbox = [task(1), task(2)];
    const poll = c.poll();
    await c.logout();
    await poll;
    expect(c.current()).toMatchObject({ loggedIn: false, tasks: [] });
    expect(ports.store.getItem('cognifly.seen')).toBeNull();
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it('a revoked session clears the notification memory', async () => {
    const { ports } = setup({ inbox: [task(1)] });
    ports.store.setItem('cognifly.seen', JSON.stringify(['x#nowe']));
    const revoked: FetchFn = vi.fn(async (url: string) => json(url.includes('cognito') ? 400 : 401, { __type: 'NotAuthorizedException' }));
    const c = new Controller({ ...ports, vault: memoryVault(JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW, email: 'm@x.pl' })), fetch: revoked });
    await c.start();
    expect(ports.store.getItem('cognifly.seen')).toBeNull();
  });

  it('a keychain refusal at start opens the login screen instead of failing', async () => {
    const { ports } = setup();
    const c = new Controller({ ...ports, vault: { read: async () => { throw 'VAULT_ERROR'; }, write: async () => undefined, remove: async () => undefined } });
    expect((await c.start()).loggedIn).toBe(false);
    expect(ports.showScreen).toHaveBeenCalledWith('login');
  });

  it('opens Claude with only the task id and the work folder', async () => {
    const { c, ports } = setup();
    await c.start();
    const h = c.handlers();
    await h['config.setWorkFolder']!({ path: '/Users/m/repo' });
    expect(await h['task.openInClaude']!({ id: id(1) })).toEqual({ ok: true });
    const url = new URL((ports.openUrl as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(url.searchParams.get('q')).toBe(`Pracuj nad zadaniem CogniFly ${id(1)}`);
    expect(url.searchParams.get('folder')).toBe('/Users/m/repo');
  });

  it('reports CLAUDE_NOT_FOUND when the OS cannot open claude://', async () => {
    const { ports } = setup();
    ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
    const c = new Controller({ ...ports, openUrl: async () => { throw new Error('no handler'); } });
    await expect(c.handlers()['task.openInClaude']!({ id: id(1) })).rejects.toMatchObject({ code: 'CLAUDE_NOT_FOUND' });
    await expect(c.handlers()['task.openInClaude']!({ id: 'x&q=1' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
  });

  it('folder picker: returns the choice, null on cancel, refuses unsafe paths', async () => {
    const { ports } = setup();
    const c = new Controller(ports);
    const pick = c.handlers()['config.pickFolder']!;
    expect(await pick({ current: '../zle' })).toEqual({ path: '/Users/m/repo' });
    expect(ports.pickFolder).toHaveBeenCalledWith('');
    const cancelled = new Controller({ ...ports, pickFolder: async () => null });
    expect(await cancelled.handlers()['config.pickFolder']!({ current: '/Users/m' })).toEqual({ path: null });
    const unsafe = new Controller({ ...ports, pickFolder: async () => '/Volumes/x/../y' });
    await expect(unsafe.handlers()['config.pickFolder']!({ current: '' })).rejects.toMatchObject({ code: 'BAD_FOLDER' });
  });

  it('work folder is required: setup opens after login, Claude waits', async () => {
    const { c, ports } = setup({ inbox: [] });
    await c.start();
    expect(ports.showScreen).toHaveBeenCalledWith('login');
    const h = c.handlers();
    await expect(h['task.openInClaude']!({ id: id(1) })).rejects.toMatchObject({ code: 'NO_WORK_FOLDER' });
    await expect(h['config.setWorkFolder']!({ path: 'wzgledny' })).rejects.toMatchObject({ code: 'BAD_FOLDER' });
    expect(await h['config.setWorkFolder']!({ path: '/Users/m/repo' })).toEqual({ ok: true });
    expect(c.current().workFolder).toBe('/Users/m/repo');
    expect(JSON.parse(ports.store.getItem('cognifly.config')!).workFolder).toBe('/Users/m/repo');
    await h['task.openInClaude']!({ id: id(1) });
    expect(ports.openUrl).toHaveBeenCalledTimes(1);
  });

  it('logged in with a folder: no setup screen at start', async () => {
    const { ports } = setup({ inbox: [] });
    ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
    await new Controller(ports).start();
    expect(ports.showScreen).not.toHaveBeenCalled();
  });

  it('focusTask: fetches the inbox, then shows it with the task highlighted', async () => {
    const { ports } = setup({ inbox: [task(1, 'zrobione')] });
    ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
    const c = new Controller(ports);
    await c.start();
    await c.focusTask(id(1));
    expect(c.current().tasks[0]!.stan).toBe('zrobione');
    expect(ports.showScreen).toHaveBeenLastCalledWith('inbox', id(1));
  });

  it('focusTask before setup shows the setup instead', async () => {
    const { c, ports } = setup({ session: null });
    await c.start();
    await c.focusTask(id(1));
    expect(ports.showScreen).toHaveBeenLastCalledWith('login');
  });

  it('review request: lists people and creates the task; bad params fail before the network', async () => {
    const { c } = setup({ inbox: [] });
    await c.start();
    const h = c.handlers();
    expect(await h['people.list']!({})).toEqual({ people: [{ osoba: 'ania' }, { osoba: 'michal' }] });
    expect(await h['review.request']!({ repo: 'o/r', pr: 4, reviewers: ['ania'] })).toEqual({ taskId: id(9) });
    await expect(h['review.request']!({ repo: 'o/r', pr: 'x', reviewers: ['ania'] })).rejects.toMatchObject({ code: 'ZLY_PR' });
  });
});
