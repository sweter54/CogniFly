import { describe, expect, it, vi } from 'vitest';
import { accessMessage, ACCESS_EVERY_MS } from '../src/logic/access.js';
import { DEFAULT_CONFIG } from '../src/logic/config.js';
import { Controller, waitingCount, type Ports } from '../src/logic/controller.js';
import { errorCode, errorDetail, NetworkError } from '../src/logic/errors.js';
import type { HeartwoodPort, HwInfo, HwReply, HwRequest } from '../src/logic/heartwood.js';
import type { FetchFn } from '../src/logic/http.js';
import { memoryStore } from '../src/logic/storage.js';
import type { InboxView } from '../src/windows/protocol.js';
import { rpcClient, rpcServer, RpcError } from '../src/logic/rpc.js';
import { jwt, memoryBus, memoryVault, STATUS_REPLY } from './helpers.js';

const NOW = 50_000_000;
const id = (n: number) => `zad_${String(n).padStart(12, '0')}`;
const task = (n: number, stan = 'nowe') => ({ id: id(n), firma: 'pilot', zdarzenieId: 'e', kandydaci: ['michal'], stan, utworzono: '', opis: `Review PR #${n}` });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const goodSession = JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 3_600_000, email: 'm@x.pl', clientId: DEFAULT_CONFIG.clientId });

const ROOT = '/Users/m/Heartwood';

/** Stored session whose access token carries `sub`. */
const sessionOf = (sub: string) => JSON.stringify({ accessToken: jwt({ sub }), refreshToken: 'R', expiresAt: NOW + 3_600_000, email: 'm@x.pl', clientId: DEFAULT_CONFIG.clientId });
/** One lock row of a `work-files` reply. */
const LOCK_W1 = { space: 'ws:w1', path: 'a.docx', folder: false, by: 'u-me', at: '2026-11-19T10:00:00Z', workId: `cognifly:${id(7)}`, writer: 'u-me', localPath: null };
/** One version row of a `work-files` reply. */
const version = (seq: number) => ({ space: 'ws:w1', path: 'a.docx', seq, author: 'u-me', at: '2026-11-19T10:00:00Z', kind: 'put', localPath: null });
/** A `work-files` reply page. */
const workFiles = (versions: unknown[], cursor?: string): HwReply => ({
  ok: true, writer: 'u-me', closed: false, locks: [LOCK_W1], hiddenLocks: 1, versions, ...(cursor ? { cursor } : {}),
});
/** Daemon calls other than the background `status` reads. */
const daemonCalls = (hw: { calls: HwRequest[] }) => hw.calls.filter((r) => r.cmd !== 'status');

/**
 * Fake Heartwood port: scripted state, picked files and replies.
 *
 * Call: `fakeHeartwood()`; mutate `hw.state`, `hw.picked`, `hw.reply`.
 * Expects: nothing.
 * Output: the port plus its mutable script and recorded calls.
 */
function fakeHeartwood() {
  const hw = {
    state: 'running' as HwInfo['state'],
    startError: null as string | null,
    startGate: Promise.resolve() as Promise<void>,
    picked: [] as string[],
    reply: (req: HwRequest): HwReply => (req.cmd === 'status' ? STATUS_REPLY : { ok: true, paths: req.paths ?? [] }),
    calls: [] as HwRequest[],
  };
  const info = (): HwInfo => ({ state: hw.state, root: ROOT, restarts: 0, lastError: null });
  const port: HeartwoodPort = {
    start: vi.fn(async () => {
      await hw.startGate;
      if (hw.startError) throw hw.startError;
      hw.state = 'running';
      return info();
    }),
    stop: vi.fn(async () => {
      hw.state = 'disabled';
    }),
    info: vi.fn(async () => info()),
    call: vi.fn(async (req: HwRequest) => {
      hw.calls.push(req);
      return hw.reply(req);
    }),
    pickFiles: vi.fn(async () => hw.picked),
  };
  return { hw, port };
}

/** Fake backend: routes by URL; `inbox` is mutable between polls. */
function setup(opts: { session?: string | null; inbox?: unknown[]; workFolder?: string } = {}) {
  const state = {
    inbox: opts.inbox ?? [], offline: false, cognito: [] as unknown[], firmy: [{ firma: 'pilot', osoba: 'michal' }],
    /** Answer of Identity `GET /access`; an Error makes it fail like the network. */
    access: { active: true } as unknown, now: NOW, inboxError: null as unknown,
    /** Access token the API accepts despite `inboxError` (a fresh claim). */
    licensedToken: null as string | null, refreshes: 0, accessGate: Promise.resolve() as Promise<void>,
  };
  /** API licence refusal for a request, while `inboxError` is set. */
  const refused = (init: RequestInit) => state.inboxError
    && (init.headers as Record<string, string>).Authorization !== `Bearer ${state.licensedToken}`;
  const fetch: FetchFn = vi.fn(async (url: string, init: RequestInit) => {
    if (state.offline) throw new TypeError('offline');
    if (url.startsWith('https://cognito-idp')) {
      state.cognito.push(JSON.parse(String(init.body)));
      if ((JSON.parse(String(init.body)) as { AuthFlow?: string }).AuthFlow === 'REFRESH_TOKEN_AUTH') {
        state.refreshes += 1;
        return json(200, { AuthenticationResult: { AccessToken: `A${state.refreshes + 1}`, ExpiresIn: 3600 } });
      }
      const target = (init.headers as Record<string, string>)['X-Amz-Target'];
      if (target?.endsWith('InitiateAuth')) return json(200, { ChallengeName: 'EMAIL_OTP', Session: 'S' });
      const code = (JSON.parse(String(init.body)) as { ChallengeResponses: { EMAIL_OTP_CODE: string } }).ChallengeResponses.EMAIL_OTP_CODE;
      if (code !== '123456') return json(400, { __type: 'CodeMismatchException' });
      return json(200, { AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R', ExpiresIn: 3600 } });
    }
    if (url.startsWith(`${DEFAULT_CONFIG.identityUrl}/access`)) {
      await state.accessGate;
      if (state.access instanceof Error) throw state.access;
      const org = new URL(url).searchParams.get('org');
      return json(200, typeof state.access === 'function' ? state.access(org) : state.access);
    }
    if (url.endsWith('/ja')) return json(200, { firmy: state.firmy });
    if (url.endsWith('/osoby')) return json(200, { osoby: [{ osoba: 'ania' }, { osoba: 'michal' }] });
    if (url.endsWith('/recenzje')) return json(200, { zadanie: task(9) });
    if (url.endsWith('/skrzynka')) return refused(init) ? json(403, state.inboxError) : json(200, { zadania: state.inbox });
    if (url.endsWith('/biore')) return json(409, { kod: 'ZAJETE', wlasciciel: 'szymon' });
    if (/\/(odrzuc|usun|przekaz|akceptuj|do-poprawy|stan)$/.test(url)) return refused(init) ? json(403, state.inboxError) : json(200, { zadanie: task(1, 'odrzucone') });
    return json(404, { kod: 'NIE_ZNALEZIONO' });
  });
  const views: InboxView[] = [];
  const { hw, port } = fakeHeartwood();
  const ports: Ports = {
    heartwood: port,
    store: memoryStore(),
    vault: memoryVault(opts.session === undefined ? goodSession : opts.session),
    fetch,
    notify: vi.fn(async () => undefined),
    render: (v) => void views.push(v),
    showScreen: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    revealFolder: vi.fn(async () => undefined),
    pickFolder: vi.fn(async (): Promise<string | null> => '/Users/m/repo'),
    now: () => state.now,
  };
  if (opts.workFolder) ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: opts.workFolder }));
  return { c: new Controller(ports), ports, state, views, hw };
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
    expect(JSON.parse((await ports.vault.read())!)).toMatchObject({ accessToken: 'A', email: 'm@x.pl', clientId: DEFAULT_CONFIG.clientId });
    expect(c.current().loggedIn).toBe(true);
  });

  it('a revoked session switches to the login screen and clears the vault', async () => {
    const { ports } = setup({ session: JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW, email: 'm@x.pl', clientId: DEFAULT_CONFIG.clientId }) });
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
    const c = new Controller({ ...ports, vault: memoryVault(JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW, email: 'm@x.pl', clientId: DEFAULT_CONFIG.clientId })), fetch: revoked });
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

  it('reject, delete and hand over call the API with checked input and refresh the inbox', async () => {
    const { c, ports } = setup({ inbox: [task(1)] });
    await c.start();
    const h = c.handlers();
    const calls = () => (ports.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u, i]) => [String(u).replace(/^.*amazonaws\.com/, ''), (i as RequestInit).body]);
    expect(await h['task.reject']!({ id: id(1), reason: '  Nie mój obszar ' })).toEqual({ ok: true });
    expect(await h['task.remove']!({ id: id(1) })).toEqual({ ok: true });
    expect(await h['task.handOver']!({ id: id(1), person: 'bartek' })).toEqual({ ok: true });
    const posted = calls().filter(([u]) => /odrzuc|usun|przekaz/.test(u as string));
    expect(posted.map(([u]) => String(u).replace(/^.*\/zadania/, ''))).toEqual([`/${id(1)}/odrzuc`, `/${id(1)}/usun`, `/${id(1)}/przekaz`]);
    expect(JSON.parse(posted[0]![1] as string)).toEqual({ powod: 'Nie mój obszar' });
    expect(JSON.parse(posted[2]![1] as string)).toEqual({ doOsoby: 'bartek' });
    const before = calls().length;
    await expect(h['task.reject']!({ id: id(1), reason: ' ' })).rejects.toMatchObject({ code: 'ZLY_POWOD' });
    await expect(h['task.reject']!({ id: id(1), reason: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'ZLY_POWOD' });
    await expect(h['task.handOver']!({ id: id(1), person: 'a b' })).rejects.toMatchObject({ code: 'ZLA_OSOBA' });
    expect(calls().filter(([u]) => /odrzuc|usun|przekaz/.test(u as string)).length).toBe(3);
    expect(calls().length).toBeGreaterThanOrEqual(before);
  });

  it('openInClaude returns to the remembered thread unless a new one is asked for', async () => {
    const w = 'local_1fb5034c-8723-4c40-85c5-981eca105464';
    const { ports } = setup({ inbox: [{ ...task(1, 'wziete'), watek: w }, { ...task(2, 'wziete'), watek: 'zly' }] });
    ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
    const c = new Controller(ports);
    await c.start();
    const h = c.handlers();
    const opened = () => (ports.openUrl as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
    await h['task.openInClaude']!({ id: id(1) });
    await h['task.openInClaude']!({ id: id(1), newThread: true });
    await h['task.openInClaude']!({ id: id(2) });
    expect(opened()[0]).toBe(`claude://code/continue?session=${w}`);
    expect(opened()[1]).toMatch(/^claude:\/\/code\/new\?/);
    expect(opened()[2]).toMatch(/^claude:\/\/code\/new\?/);
  });

  it('acceptance: state with an acceptor, accept and send back call the API', async () => {
    const { c, ports } = setup({ inbox: [task(1, 'w_trakcie')] });
    await c.start();
    const h = c.handlers();
    await h['inbox.setState']!({ id: id(1), state: 'do_akceptacji', acceptor: 'bartek' });
    await h['task.accept']!({ id: id(1) });
    await h['task.sendBack']!({ id: id(1), reason: 'Brak testów' });
    const posted = (ports.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([u]) => /\/(stan|akceptuj|do-poprawy)$/.test(String(u)))
      .map(([u, i]) => [String(u).replace(/^.*\/zadania\/[^/]+/, ''), (i as RequestInit).body ? JSON.parse(String((i as RequestInit).body)) : undefined]);
    expect(posted).toEqual([
      ['/stan', { stan: 'do_akceptacji', akceptujacy: 'bartek' }],
      ['/akceptuj', undefined],
      ['/do-poprawy', { powod: 'Brak testów' }],
    ]);
    await expect(h['task.sendBack']!({ id: id(1), reason: '' })).rejects.toMatchObject({ code: 'ZLY_POWOD' });
    await expect(h['inbox.setState']!({ id: id(1), state: 'do_akceptacji', acceptor: 'a b' })).rejects.toMatchObject({ code: 'ZLA_OSOBA' });
  });

  describe('files (Heartwood)', () => {
    const lockId = id(7);

    it('after login starts the daemon for the company; disabled does not break the inbox', async () => {
      const { c, ports, hw } = setup({ workFolder: '/Users/m/repo', inbox: [task(1)] });
      hw.state = 'disabled';
      hw.startError = 'DISABLED';
      const v = await c.start();
      expect(ports.heartwood.start).toHaveBeenCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, DEFAULT_CONFIG.identityUrl, 'pilot', '/Users/m/repo/Pliki');
      expect(v.tasks).toHaveLength(1);
      expect(v.files.info.state).toBe('disabled');
      expect(v.files.status).toBeNull();
      expect(hw.calls).toEqual([]);
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenCalledTimes(1);
    });

    it('without a work folder the daemon is not started', async () => {
      const { c, ports } = setup({ inbox: [] });
      await c.start();
      expect(ports.heartwood.start).not.toHaveBeenCalled();
    });

    it('a work folder change restarts the daemon with the new root', async () => {
      const { c, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      await c.handlers()['config.setWorkFolder']!({ path: '/Users/m/inne' });
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, DEFAULT_CONFIG.identityUrl, 'pilot', '/Users/m/inne/Pliki');
      expect(ports.heartwood.start).toHaveBeenCalledTimes(2);
    });

    it('running daemon: status is read at each poll and counted', async () => {
      const { c } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      const v = await c.start();
      expect(v.files.status?.connected).toBe(true);
      expect(v.files.counts).toEqual({ conflicts: 2, unsent: 7 });
      expect(await c.handlers()['files.get']!({})).toEqual(v.files);
    });

    it('a company change restarts the daemon with the new org', async () => {
      const { c, state, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
      await c.start();
      await c.handlers()['config.setCompany']!({ company: 'acme' });
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, DEFAULT_CONFIG.identityUrl, 'acme', '/Users/m/repo/Pliki');
    });

    it('lock refuses paths outside root without calling the daemon', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.calls = [];
      hw.picked = [`${ROOT}/pilot/w1/a.docx`, '/Users/m/Desktop/x.docx'];
      await expect(c.handlers()['task.lockFiles']!({ id: lockId })).rejects.toMatchObject({ code: 'OUTSIDE' });
      expect(hw.calls).toEqual([]);
    });

    it('lockFiles locks the picked files per space with the work id and keeps no memory', async () => {
      const { c, hw, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      const picked = [`${ROOT}/pilot/w1/a.docx`, `${ROOT}/pilot/w2/b.xlsx`];
      hw.picked = picked;
      expect(await c.handlers()['task.lockFiles']!({ id: lockId })).toEqual({ paths: picked });
      expect(daemonCalls(hw)).toEqual([
        { cmd: 'lock', workId: `cognifly:${lockId}`, paths: [picked[0]] },
        { cmd: 'lock', workId: `cognifly:${lockId}`, paths: [picked[1]] },
      ]);
      expect(ports.store.getItem('cognifly.heartwood.locks')).toBeNull();
    });

    it('lockFiles and releaseFiles send at most 98 paths per request', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.picked = Array.from({ length: 150 }, (_, i) => `${ROOT}/pilot/w1/f${i}.docx`);
      await c.handlers()['task.lockFiles']!({ id: lockId });
      expect(daemonCalls(hw).filter((r) => r.cmd === 'lock').map((r) => (r.paths as string[]).length)).toEqual([98, 52]);
      hw.calls = [];
      const locks = Array.from({ length: 150 }, (_, i) => ({ ...LOCK_W1, path: `f${i}.docx` }));
      hw.reply = (req) => {
        if (req.cmd === 'work-files') return { ...workFiles([]), locks };
        if (req.cmd === 'release') return { ok: true, space: req.space, paths: req.paths };
        return STATUS_REPLY;
      };
      await c.handlers()['task.releaseFiles']!({ id: lockId });
      expect(daemonCalls(hw).filter((r) => r.cmd === 'release').map((r) => (r.paths as string[]).length)).toEqual([98, 52]);
    });

    it('a cancelled picker locks nothing; a bad task id is refused', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.calls = [];
      expect(await c.handlers()['task.lockFiles']!({ id: lockId })).toEqual({ paths: [] });
      await expect(c.handlers()['task.lockFiles']!({ id: 'x' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
      expect(hw.calls).toEqual([]);
    });

    it('a daemon refusal surfaces as its code', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.picked = [`${ROOT}/pilot/w1/a.docx`];
      hw.reply = () => ({ ok: false, code: 'LOCKED', message: 'Plik blokuje Ania.' });
      await expect(c.handlers()['task.lockFiles']!({ id: lockId })).rejects.toMatchObject({ code: 'LOCKED' });
    });

    it('task.files calls work-files with the work id, merges version pages and returns me', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [], session: sessionOf('u-me') });
      await c.start();
      hw.reply = (req) => {
        if (req.cmd !== 'work-files') return STATUS_REPLY;
        if (req.cursor === undefined) return workFiles([version(3)], 'p2');
        return workFiles([version(2), { bad: true }]);
      };
      const r = await c.handlers()['task.files']!({ id: lockId });
      expect(daemonCalls(hw)).toEqual([
        { cmd: 'work-files', workId: `cognifly:${lockId}` },
        { cmd: 'work-files', workId: `cognifly:${lockId}`, cursor: 'p2' },
      ]);
      expect(r).toEqual({
        id: lockId,
        me: 'u-me',
        files: { writer: 'u-me', closed: false, locks: [LOCK_W1], hiddenLocks: 1, versions: [version(3), version(2)] },
      });
    });

    it('task.files stops after 20 pages and keeps the cursor; a bad reply is BAD_RESPONSE', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.reply = (req) => (req.cmd === 'work-files' ? workFiles([version(1)], 'more') : STATUS_REPLY);
      const r = await c.handlers()['task.files']!({ id: lockId }) as { files: { versions: unknown[]; cursor?: string }; me: unknown };
      expect(daemonCalls(hw)).toHaveLength(20);
      expect(r.files.versions).toHaveLength(20);
      expect(r.files.cursor).toBe('more');
      expect(r.me).toBeNull();
      hw.reply = (req) => (req.cmd === 'work-files' ? { ok: true, writer: 5 } : STATUS_REPLY);
      await expect(c.handlers()['task.files']!({ id: lockId })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
      await expect(c.handlers()['task.files']!({ id: 'zad_x' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
    });

    it('releaseFiles without a path releases every visible lock, one call per space', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      const locks = [LOCK_W1, { ...LOCK_W1, path: 'Oferty', folder: true }, { ...LOCK_W1, space: 'ws:w2', path: 'b.xlsx' }];
      hw.reply = (req) => {
        if (req.cmd === 'work-files') return { ...workFiles([]), locks };
        if (req.cmd === 'release') return { ok: true, space: req.space, paths: req.paths };
        return STATUS_REPLY;
      };
      expect(await c.handlers()['task.releaseFiles']!({ id: lockId })).toEqual({ paths: ['a.docx', 'Oferty', 'b.xlsx'] });
      expect(daemonCalls(hw).filter((r) => r.cmd === 'release')).toEqual([
        { cmd: 'release', space: 'ws:w1', paths: ['a.docx', 'Oferty'] },
        { cmd: 'release', space: 'ws:w2', paths: ['b.xlsx'] },
      ]);
    });

    it('releaseFiles with space and path releases one lock; a bad path is refused first', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.calls = [];
      const h = c.handlers();
      expect(await h['task.releaseFiles']!({ id: lockId, space: 'ws:w1', path: 'Oferty/a.docx' })).toEqual({ paths: ['Oferty/a.docx'] });
      expect(daemonCalls(hw)).toEqual([{ cmd: 'release', space: 'ws:w1', paths: ['Oferty/a.docx'] }]);
      hw.calls = [];
      for (const path of ['../a', '/abs', 'a//b', 'a/', '', 'a\u0007b']) {
        await expect(h['task.releaseFiles']!({ id: lockId, space: 'ws:w1', path })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      await expect(h['task.releaseFiles']!({ id: lockId, space: '', path: 'a' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(hw.calls).toEqual([]);
    });

    it('files.tree passes space and folder and returns the parsed level', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      const entry = { path: 'Oferty/a.docx', localPath: null, folder: false, state: 'free' };
      hw.reply = (req) => (req.cmd === 'files' ? { ok: true, space: 'ws:w1', folder: 'Oferty', selected: false, entries: [entry, 7] } : STATUS_REPLY);
      const h = c.handlers();
      expect(await h['files.tree']!({ space: 'ws:w1', folder: 'Oferty' })).toEqual({ space: 'ws:w1', folder: 'Oferty', selected: false, entries: [entry] });
      await h['files.tree']!({ space: 'ws:w1' });
      expect(daemonCalls(hw)).toEqual([{ cmd: 'files', space: 'ws:w1', folder: 'Oferty' }, { cmd: 'files', space: 'ws:w1' }]);
      hw.calls = [];
      await expect(h['files.tree']!({ space: 'ws:w1', folder: '../x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.tree']!({ space: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(daemonCalls(hw)).toEqual([]);
      hw.reply = () => ({ ok: true, space: 'ws:w1' });
      await expect(h['files.tree']!({ space: 'ws:w1' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    });

    it('files.lockFor checks the task id and path before locking with space and work id', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.calls = [];
      const h = c.handlers();
      await expect(h['files.lockFor']!({ taskId: 'x', space: 'ws:w1', path: 'a.docx' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
      await expect(h['files.lockFor']!({ taskId: lockId, space: 'ws:w1', path: '../a.docx' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.lockFor']!({ taskId: lockId, space: 'ws:w1', path: 'a/../b' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(daemonCalls(hw)).toEqual([]);
      expect(await h['files.lockFor']!({ taskId: lockId, space: 'ws:w1', path: 'Oferty/a.docx' })).toEqual({ ok: true });
      expect(await h['files.lockFor']!({ taskId: lockId, space: 'ws:w1', path: 'Oferty', folder: true })).toEqual({ ok: true });
      expect(daemonCalls(hw)).toEqual([
        { cmd: 'lock', space: 'ws:w1', workId: `cognifly:${lockId}`, paths: ['Oferty/a.docx'] },
        { cmd: 'lock', space: 'ws:w1', workId: `cognifly:${lockId}`, paths: ['Oferty'], folder: true },
      ]);
    });

    it('request release, history and download work with a space path', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.reply = (req) => {
        if (req.cmd === 'history') return { ok: true, versions: [] };
        if (req.cmd === 'download') return { ok: true, copy: '/Users/m/Downloads/a.docx' };
        return { ok: true };
      };
      hw.calls = [];
      const h = c.handlers();
      expect(await h['files.requestRelease']!({ space: 'ws:w1', path: 'a.docx' })).toEqual({ ok: true });
      expect(await h['files.history']!({ space: 'ws:w1', path: 'Oferty/' })).toEqual({ versions: [], path: 'Oferty/' });
      expect(await h['files.history']!({ space: 'ws:w1', path: '' })).toEqual({ versions: [], path: '' });
      expect(await h['files.download']!({ space: 'ws:w1', path: 'a.docx', version: 2 })).toEqual({ copy: '/Users/m/Downloads/a.docx' });
      expect(daemonCalls(hw)).toEqual([
        { cmd: 'request-release', space: 'ws:w1', path: 'a.docx' },
        { cmd: 'history', space: 'ws:w1', path: 'Oferty/' },
        { cmd: 'history', space: 'ws:w1', path: '' },
        { cmd: 'download', space: 'ws:w1', path: 'a.docx', version: 2 },
      ]);
      hw.calls = [];
      await expect(h['files.requestRelease']!({ space: 'ws:w1', path: 'a/' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.download']!({ space: 'ws:w1', path: 'a/', version: 2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.history']!({ space: 'ws:w1', path: '../' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.history']!({ space: 'ws:w1', path: `${ROOT}/pilot/w1/a.docx` })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(daemonCalls(hw)).toEqual([]);
    });

    it('a transport failure (string code from invoke) surfaces as its code', async () => {
      const { c, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      (ports.heartwood.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce('NOT_RUNNING');
      await expect(c.handlers()['files.history']!({ path: `${ROOT}/pilot/w1/a.docx` })).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    });

    it('history, download and restore pass checked params to the daemon', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      const path = `${ROOT}/pilot/w1/a.docx`;
      const version = { seq: 3, versionId: 'v3', sha256: 'ab', size: 1, author: 'ania', at: '2026-11-19T10:00:00Z', kind: 'put' };
      hw.reply = (req) => {
        if (req.cmd === 'history') return { ok: true, space: 'ws:w1', path: 'a.docx', versions: [version] };
        if (req.cmd === 'download') return { ok: true, copy: `${ROOT}/pilot/w1/a (v3).docx` };
        return { ok: true };
      };
      const h = c.handlers();
      expect(await h['files.history']!({ path })).toEqual({ versions: [version], path });
      expect(await h['files.download']!({ path, version: 3 })).toEqual({ copy: `${ROOT}/pilot/w1/a (v3).docx` });
      expect(await h['files.restore']!({ path, version: 3 })).toEqual({ ok: true });
      expect(hw.calls).toContainEqual({ cmd: 'restore', path, version: 3 });
      await expect(h['files.download']!({ path, version: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.history']!({ path: '/etc/passwd' })).rejects.toMatchObject({ code: 'OUTSIDE' });
    });

    it('select and unselect pass space, topics and confirmation', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      const h = c.handlers();
      expect(await h['files.select']!({ space: 'w1', topics: ['umowy'] })).toEqual({ ok: true });
      expect(await h['files.unselect']!({ space: 'w1', yes: true })).toEqual({ ok: true });
      expect(hw.calls).toContainEqual({ cmd: 'select', space: 'w1', topics: ['umowy'] });
      expect(hw.calls).toContainEqual({ cmd: 'unselect', space: 'w1', yes: true });
      await expect(h['files.select']!({ space: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('pickPath returns a picked file under root, null on cancel', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      expect(await c.handlers()['files.pickPath']!({})).toEqual({ path: null });
      hw.picked = [`${ROOT}/pilot/w1/a.docx`];
      expect(await c.handlers()['files.pickPath']!({})).toEqual({ path: `${ROOT}/pilot/w1/a.docx` });
    });

    it('a daemon refusal reaches the window with its code and Polish text', async () => {
      const { c, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      hw.picked = [`${ROOT}/pilot/w1/a.docx`];
      hw.reply = () => ({ ok: false, code: 'LOCKED', message: 'Plik blokuje Ania.' });
      const b = memoryBus();
      await rpcServer(b('background'), c.handlers(), errorCode, errorDetail);
      const call = await rpcClient(b('main'), 'main');
      const err = await call('task.lockFiles', { id: lockId }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err).toMatchObject({ code: 'LOCKED', detail: 'Plik blokuje Ania.' });
      expect(await call('task.lockFiles', { id: 'x' }).catch((e: unknown) => e)).toMatchObject({ code: 'BAD_TASK_ID', detail: undefined });
    });

    it('logout during an in-flight start: the next login starts the daemon again', async () => {
      const { c, ports, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      let open!: () => void;
      hw.startGate = new Promise((r) => { open = r; });
      const starting = c.start();
      await vi.waitFor(() => expect(ports.heartwood.start).toHaveBeenCalledTimes(1));
      await c.logout();
      open();
      await starting;
      expect(ports.heartwood.stop).toHaveBeenCalledTimes(2); // the late start is stopped again
      expect(c.current().files.status).toBeNull();
      const h = c.handlers();
      await h['login.sendCode']!({ email: 'm@x.pl' });
      await h['login.confirm']!({ code: '123456' });
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenCalledTimes(2);
      expect(c.current().files.counts).toEqual({ conflicts: 2, unsent: 7 });
    });

    it('a company change stops the old daemon; a failed new start shows no old status', async () => {
      const { c, state, ports, hw } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
      await c.start();
      expect(c.current().files.counts.conflicts).toBe(2);
      hw.startError = 'NO_EXE';
      await c.handlers()['config.setCompany']!({ company: 'acme' });
      await c.poll();
      expect(ports.heartwood.stop).toHaveBeenCalledTimes(1);
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, DEFAULT_CONFIG.identityUrl, 'acme', '/Users/m/repo/Pliki');
      expect(c.current().files).toMatchObject({ status: null, counts: { conflicts: 0, unsent: 0 } });
      hw.startError = null;
      await c.poll();
      expect(c.current().files.counts.conflicts).toBe(2); // retried at the next poll
    });

    it('files.reveal opens the local folder of a selected space under the root', async () => {
      const { c, hw, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      const spaces = [{ space: 'ws:w1', folder: `${ROOT}/pilot/w1`, lastSeq: 1, serverSeq: 1, unsent: 0 }];
      hw.reply = (req) => (req.cmd === 'status' ? { ...STATUS_REPLY, spaces } : { ok: true });
      await c.start();
      const h = c.handlers();
      expect(await h['files.reveal']!({ space: 'ws:w1', folder: '' })).toEqual({ ok: true });
      await h['files.reveal']!({ space: 'ws:w1', folder: 'Oferty/2026/' });
      expect(ports.revealFolder).toHaveBeenNthCalledWith(1, `${ROOT}/pilot/w1`);
      expect(ports.revealFolder).toHaveBeenNthCalledWith(2, `${ROOT}/pilot/w1/Oferty/2026`);
      await h['files.reveal']!({ space: 'ws:w1', folder: 'Narzedzia/Evil.app' });
      expect(ports.revealFolder).toHaveBeenLastCalledWith(`${ROOT}/pilot/w1/Narzedzia/Evil.app`);
      expect(ports.openUrl).not.toHaveBeenCalled();
    });

    it('files.reveal refuses bad folders, unselected spaces and paths outside the root', async () => {
      const { c, hw, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      const spaces = [{ space: 'ws:w1', folder: `${ROOT}/pilot/w1`, lastSeq: 1, serverSeq: 1, unsent: 0 }, { space: 'ws:x', folder: '/tmp/x', lastSeq: 1, serverSeq: 1, unsent: 0 }];
      hw.reply = (req) => (req.cmd === 'status' ? { ...STATUS_REPLY, spaces } : { ok: true });
      await c.start();
      const h = c.handlers();
      await expect(h['files.reveal']!({ space: 'ws:w1', folder: '../x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.reveal']!({ space: 'ws:w1', folder: 7 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(h['files.reveal']!({ space: 'ws:w2', folder: '' })).rejects.toMatchObject({ code: 'NOT_LOCAL' });
      await expect(h['files.reveal']!({ space: 'ws:x', folder: '' })).rejects.toMatchObject({ code: 'OUTSIDE' });
      expect(ports.revealFolder).not.toHaveBeenCalled();
      vi.mocked(ports.revealFolder).mockRejectedValueOnce('Not allowed to open path');
      await expect(h['files.reveal']!({ space: 'ws:w1', folder: '' })).rejects.toMatchObject({ code: 'OPEN_FAILED' });
    });

    it('files.reveal passes on the daemon error instead of NOT_LOCAL', async () => {
      const { c, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      (ports.heartwood.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce('TIMEOUT');
      await expect(c.handlers()['files.reveal']!({ space: 'ws:w1', folder: '' })).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(ports.revealFolder).not.toHaveBeenCalled();
    });

    describe('adopt, resolve and conflict copies', () => {
      const W1 = `${ROOT}/pilot/w1`;
      const SPACES = [{ space: 'ws:w1', folder: W1, lastSeq: 1, serverSeq: 1, unsent: 0 }, { space: 'user:u-me', folder: `${ROOT}/pilot/Prywatne`, lastSeq: 1, serverSeq: 1, unsent: 0 }];
      const mine = { ...task(7, 'wziete'), wlasciciel: 'michal', opis: 'Oferta: Acme/2026' };
      const notMine = { ...task(8, 'wziete'), wlasciciel: 'ania' };
      const dir = (path: string) => ({ path, localPath: null, folder: true, state: 'free', lockFolder: false });

      /**
       * Controller with a selected space, two tasks and a daemon that
       * answers `files` with `zadania` and `adopt` like the contract.
       */
      async function adoptSetup(zadania: unknown = { ok: true, space: 'ws:w1', folder: 'Zadania', selected: true, entries: [] }) {
        const t = setup({ workFolder: '/Users/m/repo', inbox: [mine, notMine] });
        t.hw.reply = (req) => {
          if (req.cmd === 'status') return { ...STATUS_REPLY, spaces: SPACES };
          if (req.cmd === 'files') return zadania as HwReply;
          if (req.cmd === 'adopt') {
            const folder = `Zadania/${String(req.taskFolder)}`;
            return { ok: true, space: 'ws:w1', folder, moved: (req.paths as string[]).map((from) => ({ from, to: `${W1}/${folder}/x` })) };
          }
          return { ok: true };
        };
        await t.c.start();
        return t;
      }

      it('adopt requires an explicit task', async () => {
        const { c, hw } = await adoptSetup();
        const h = c.handlers();
        const paths = [`${W1}/luzem.txt`];
        await expect(h['files.adopt']!({ paths })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
        await expect(h['files.adopt']!({ paths, taskId: '' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
        await expect(h['files.adopt']!({ paths, taskId: notMine.id })).rejects.toMatchObject({ code: 'TASK_NOT_LOCKABLE' });
        await expect(h['files.adopt']!({ paths, taskId: id(99) })).rejects.toMatchObject({ code: 'TASK_NOT_LOCKABLE' });
        expect(daemonCalls(hw)).toEqual([]);
      });

      it('adopt makes a new task folder from the description', async () => {
        const { c, hw } = await adoptSetup();
        const paths = [`${W1}/luzem.txt`, `${W1}/Oferty/nowy.docx`];
        const r = await c.handlers()['files.adopt']!({ paths, taskId: mine.id });
        const taskFolder = `Oferta Acme-2026 (${mine.id})`;
        expect(daemonCalls(hw)).toEqual([
          { cmd: 'files', space: 'ws:w1', folder: 'Zadania' },
          { cmd: 'adopt', paths, workId: `cognifly:${mine.id}`, taskFolder },
        ]);
        expect(r).toEqual({ folder: `Zadania/${taskFolder}`, moved: paths.map((from) => ({ from, to: `${W1}/Zadania/${taskFolder}/x` })) });
      });

      it('adopt finds the space of a folder written with a trailing slash', async () => {
        const { c, hw } = await adoptSetup();
        const base = hw.reply;
        hw.reply = (req) => (req.cmd === 'status' ? { ...STATUS_REPLY, spaces: [{ ...SPACES[0], folder: `${W1}/` }] } : base(req));
        await c.handlers()['files.adopt']!({ paths: [`${W1}/luzem.txt`], taskId: mine.id });
        expect(daemonCalls(hw)[0]).toEqual({ cmd: 'files', space: 'ws:w1', folder: 'Zadania' });
      });

      it('adopt reuses the existing folder of the task', async () => {
        const entries = [dir('Zadania/Inna (zad_000000000001)'), dir(`Zadania/Stara nazwa (${mine.id})`)];
        const { c, hw } = await adoptSetup({ ok: true, space: 'ws:w1', folder: 'Zadania', selected: true, entries });
        await c.handlers()['files.adopt']!({ paths: [`${W1}/luzem.txt`], taskId: mine.id });
        expect(daemonCalls(hw)[1]).toMatchObject({ cmd: 'adopt', taskFolder: `Stara nazwa (${mine.id})` });
      });

      it('adopt without a Zadania topic yet uses the new name', async () => {
        const { c, hw } = await adoptSetup({ ok: false, code: 'NOT_FOUND', message: 'Nie ma tematu.' });
        await c.handlers()['files.adopt']!({ paths: [`${W1}/luzem.txt`], taskId: mine.id });
        expect(daemonCalls(hw)[1]).toMatchObject({ cmd: 'adopt', taskFolder: `Oferta Acme-2026 (${mine.id})` });
      });

      it('adopt refuses bad paths before any daemon call', async () => {
        const { c, hw } = await adoptSetup();
        const h = c.handlers();
        const taskId = mine.id;
        await expect(h['files.adopt']!({ paths: [], taskId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.adopt']!({ paths: 'x', taskId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.adopt']!({ paths: ['/etc/passwd'], taskId })).rejects.toMatchObject({ code: 'OUTSIDE' });
        await expect(h['files.adopt']!({ paths: [`${W1}/../x`], taskId })).rejects.toMatchObject({ code: 'OUTSIDE' });
        await expect(h['files.adopt']!({ paths: [`${W1}/a`, `${ROOT}/pilot/w2/b`], taskId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.adopt']!({ paths: [`${ROOT}/pilot/Prywatne/a`], taskId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.adopt']!({ paths: [`${ROOT}/pilot/w9/a`], taskId })).rejects.toMatchObject({ code: 'NOT_LOCAL' });
        expect(daemonCalls(hw)).toEqual([]);
      });

      it('adopt passes the daemon refusal with its Polish text', async () => {
        const { c, hw } = await adoptSetup();
        const base = hw.reply;
        hw.reply = (req) => (req.cmd === 'adopt' ? { ok: false, code: 'LOCKED', message: 'Folder zadania blokuje Ania.' } : base(req));
        const b = memoryBus();
        await rpcServer(b('background'), c.handlers(), errorCode, errorDetail);
        const call = await rpcClient(b('main'), 'main');
        const err = await call('files.adopt', { paths: [`${W1}/luzem.txt`], taskId: mine.id }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'LOCKED', detail: 'Folder zadania blokuje Ania.' });
      });

      it('resolve clears a whole file or one copy', async () => {
        const { c, hw } = await adoptSetup();
        const h = c.handlers();
        expect(await h['files.resolve']!({ space: 'ws:w1', path: 'b.docx' })).toEqual({ ok: true });
        const copyPath = `${W1}/Kopie konfliktów/b (konflikt 2026-11-19 10-00).docx`;
        await h['files.resolve']!({ copyPath });
        expect(daemonCalls(hw)).toEqual([{ cmd: 'resolve', space: 'ws:w1', path: 'b.docx' }, { cmd: 'resolve', copyPath }]);
      });

      it('resolve takes exactly one target', async () => {
        const { c, hw } = await adoptSetup();
        const h = c.handlers();
        const copyPath = `${W1}/Kopie konfliktów/b.docx`;
        await expect(h['files.resolve']!({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.resolve']!({ copyPath, space: 'ws:w1', path: 'b.docx' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.resolve']!({ space: 'ws:w1', path: '../b' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(h['files.resolve']!({ copyPath: '/tmp/Kopie konfliktów/b.docx' })).rejects.toMatchObject({ code: 'OUTSIDE' });
        expect(daemonCalls(hw)).toEqual([]);
      });

      it('revealCopy shows only conflict copies under the root', async () => {
        const { c, ports } = await adoptSetup();
        const h = c.handlers();
        const copy = `${W1}/Oferty/Kopie konfliktów/b (konflikt 2026-11-19 10-00).docx`;
        expect(await h['files.revealCopy']!({ copyPath: copy })).toEqual({ ok: true });
        expect(ports.revealFolder).toHaveBeenCalledWith(copy);
        await expect(h['files.revealCopy']!({ copyPath: `${W1}/Oferty/b.docx` })).rejects.toMatchObject({ code: 'NOT_COPY' });
        await expect(h['files.revealCopy']!({ copyPath: '/tmp/Kopie konfliktów/b.docx' })).rejects.toMatchObject({ code: 'OUTSIDE' });
        await expect(h['files.revealCopy']!({ copyPath: 7 })).rejects.toMatchObject({ code: 'OUTSIDE' });
        expect(ports.revealFolder).toHaveBeenCalledTimes(1);
        vi.mocked(ports.revealFolder).mockRejectedValueOnce('denied');
        await expect(h['files.revealCopy']!({ copyPath: copy })).rejects.toMatchObject({ code: 'OPEN_FAILED' });
      });
    });

    it('task.focus shows the task in the inbox and checks the id', async () => {
      const { ports } = setup({ workFolder: '/Users/m/repo', inbox: [task(1)] });
      ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
      const c = new Controller(ports);
      await c.start();
      expect(await c.handlers()['task.focus']!({ id: id(1) })).toEqual({ ok: true });
      expect(ports.showScreen).toHaveBeenLastCalledWith('inbox', id(1));
      await expect(c.handlers()['task.focus']!({ id: 'zle' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
    });

    it('logout stops the daemon and clears the files view', async () => {
      const { c, ports } = setup({ workFolder: '/Users/m/repo', inbox: [] });
      await c.start();
      await c.handlers()['session.logout']!({});
      expect(ports.heartwood.stop).toHaveBeenCalled();
      expect(c.current().files.status).toBeNull();
    });
  });

  describe('access check (Identity)', () => {
    /** Paths of all requests so far, in order (Identity and API). */
    const paths = (ports: Ports) => vi.mocked(ports.fetch).mock.calls.map(([u]) => new URL(String(u)).pathname);
    const accessCalls = (ports: Ports) => paths(ports).filter((p) => p === '/access').length;
    const inboxCalls = (ports: Ports) => paths(ports).filter((p) => p.endsWith('/skrzynka')).length;

    it('start_checks_access_before_poll', async () => {
      const { c, ports } = setup({ inbox: [task(1)] });
      await c.start();
      const calls = vi.mocked(ports.fetch).mock.calls;
      expect(String(calls[0]![0])).toBe(`${DEFAULT_CONFIG.identityUrl}/access?product=cognifly&org=${DEFAULT_CONFIG.company}`);
      expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer A');
      expect(paths(ports).slice(1)).toEqual(['/ja', '/skrzynka']);
      expect(c.current().blocked).toBeNull();
    });

    it('company_change_checks_access_for_the_new_company', async () => {
      const { c, ports, state } = setup({ inbox: [] });
      state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
      await c.start();
      await c.handlers()['config.setCompany']!({ company: 'acme' });
      await c.poll();
      expect(accessOrgs(ports)).toEqual(['pilot', 'acme']);
    });

    /** Orgs asked in `GET /access`, in order. */
    const accessOrgs = (ports: Ports) => vi.mocked(ports.fetch).mock.calls.map(([u]) => new URL(String(u)))
      .filter((u) => u.pathname === '/access').map((u) => u.searchParams.get('org'));
    const STALE_ACCESS = (ok: string) => (org: string | null) => (org === ok ? { active: true } : { active: false, reason: 'NOT_MEMBER' });

    it('stale_company_not_member_moves_to_the_only_company_and_says_so', async () => {
      const { c, ports, state } = setup({ inbox: [] });
      ports.log = vi.fn();
      state.firmy = [{ firma: 'acme', osoba: 'mr' }];
      state.access = STALE_ACCESS('acme');
      const v = await c.start();
      expect(v).toMatchObject({ loggedIn: true, blocked: null, osoba: 'mr' });
      expect(accessOrgs(ports)).toEqual(['pilot', 'acme']);
      expect(ports.notify).toHaveBeenCalledWith('CogniFly — zmiana firmy', 'Nie należysz już do firmy pilot — przełączono na firmę acme.');
      expect(ports.log).toHaveBeenCalledWith('company changed: pilot -> acme (not a member)');
    });

    it('stale_company_with_two_companies_blocks_until_the_person_chooses', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      ports.log = vi.fn();
      state.firmy = [{ firma: 'acme', osoba: 'mr' }, { firma: 'beta', osoba: 'mb' }];
      state.access = STALE_ACCESS('beta');
      const v = await c.start();
      expect(v).toMatchObject({ loggedIn: true, blocked: 'Nie należysz już do firmy pilot — wybierz firmę w Ustawieniach.', tasks: [] });
      expect(await ports.vault.read()).not.toBeNull();
      expect(paths(ports).filter((p) => p.endsWith('/skrzynka'))).toHaveLength(0);
      expect(ports.notify).not.toHaveBeenCalled();
      expect(ports.log).toHaveBeenCalledWith('company pilot left; choice needed among 2');
      expect(c.current().blocked).not.toBeNull();
      await c.handlers()['config.setCompany']!({ company: 'beta' });
      const after = await c.poll();
      expect(after).toMatchObject({ blocked: null, tasks: [task(1)] });
      expect(accessOrgs(ports).at(-1)).toBe('beta');
    });

    it('stale_company_seen_by_ja_after_a_failed_access_check_blocks_with_two_companies', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      state.firmy = [{ firma: 'acme', osoba: 'mr' }, { firma: 'beta', osoba: 'mb' }];
      state.access = new TypeError('offline');
      const v = await c.start();
      expect(v).toMatchObject({ blocked: 'Nie należysz już do firmy pilot — wybierz firmę w Ustawieniach.', tasks: [], offline: false });
      expect(paths(ports).filter((p) => p.endsWith('/skrzynka'))).toHaveLength(0);
    });

    it('automatic_company_change_cleans_up_like_a_manual_one', async () => {
      const { c, ports, state } = setup({ workFolder: '/Users/m/repo', inbox: [task(1)] });
      await c.start();
      expect(c.current().tasks).toHaveLength(1);
      state.firmy = [{ firma: 'acme', osoba: 'mr' }];
      state.access = STALE_ACCESS('acme');
      state.inbox = [task(2)];
      state.now += ACCESS_EVERY_MS;
      const v = await c.poll();
      expect(ports.heartwood.stop).toHaveBeenCalledTimes(1);
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, DEFAULT_CONFIG.identityUrl, 'acme', '/Users/m/repo/Pliki');
      expect(v).toMatchObject({ osoba: 'mr', tasks: [task(2)] });
      // seen memory was cleared: the new company's tasks are counted, not announced
      expect(vi.mocked(ports.notify).mock.calls.map(([t]) => t)).toEqual(['CogniFly — zmiana firmy']);
    });

    it('access_checked_every_five_minutes', async () => {
      const { c, ports, state } = setup({ inbox: [] });
      await c.start();
      state.now += ACCESS_EVERY_MS - 1;
      await c.poll();
      expect(accessCalls(ports)).toBe(1);
      state.now += 1;
      await c.poll();
      expect(accessCalls(ports)).toBe(2);
    });

    it('licence_expired_blocks_polling_and_shows_reason', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)], workFolder: '/Users/m/repo' });
      await c.start();
      state.access = { active: false, reason: 'LICENCE_EXPIRED' };
      state.now += ACCESS_EVERY_MS;
      const v = await c.poll();
      expect(v).toMatchObject({ loggedIn: true, blocked: accessMessage('LICENCE_EXPIRED') });
      expect(v.tasks).toHaveLength(1);
      expect(inboxCalls(ports)).toBe(1);
      const h = c.handlers();
      const actions: [keyof typeof h, unknown][] = [
        ['inbox.take', { id: id(1) }], ['inbox.setState', { id: id(1), state: 'zrobione' }], ['task.accept', { id: id(1) }],
        ['task.sendBack', { id: id(1), reason: 'x' }], ['task.reject', { id: id(1), reason: 'x' }], ['task.remove', { id: id(1) }],
        ['task.handOver', { id: id(1), person: 'ania' }], ['review.request', { repo: 'o/r', pr: 1, reviewers: ['ania'] }],
        ['task.openInClaude', { id: id(1) }],
      ];
      const before = vi.mocked(ports.fetch).mock.calls.length;
      for (const [m, p] of actions) await expect(h[m]!(p)).rejects.toMatchObject({ code: 'BLOCKED' });
      expect(vi.mocked(ports.fetch).mock.calls.length).toBe(before);
      expect(ports.openUrl).not.toHaveBeenCalled();
    });

    it('not_member_logs_out', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      state.access = { active: false, reason: 'NOT_MEMBER' };
      const v = await c.start();
      expect(v).toMatchObject({ loggedIn: false, tasks: [], blocked: accessMessage('NOT_MEMBER') });
      expect(await ports.vault.read()).toBeNull();
      expect(ports.showScreen).toHaveBeenLastCalledWith('login');
      expect(inboxCalls(ports)).toBe(0);
      state.access = { active: true };
      const h = c.handlers();
      await h['login.sendCode']!({ email: 'm@x.pl' });
      await h['login.confirm']!({ code: '123456' });
      await c.poll();
      expect(c.current()).toMatchObject({ loggedIn: true, blocked: null });
      expect(accessCalls(ports)).toBe(2);
    });

    it('access_network_error_does_not_block', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      state.access = new TypeError('offline');
      const v = await c.start();
      expect(v).toMatchObject({ loggedIn: true, blocked: null });
      expect(v.tasks).toHaveLength(1);
      await c.poll();
      expect(accessCalls(ports)).toBe(2);
    });

    it('active_again_unblocks_and_polls', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      state.access = { active: false, reason: 'NO_LICENCE' };
      expect((await c.start()).blocked).toBe(accessMessage('NO_LICENCE'));
      expect(inboxCalls(ports)).toBe(0);
      state.access = { active: true };
      const v = await c.poll();
      expect(v.blocked).toBeNull();
      expect(v.tasks).toHaveLength(1);
      expect(inboxCalls(ports)).toBe(1);
    });

    it('api_licence_error_forces_access_check', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      await c.start();
      state.inboxError = { kod: 'LICENCJA_WYGASLA' };
      state.access = { active: false, reason: 'LICENCE_EXPIRED' };
      const v = await c.poll();
      expect(accessCalls(ports)).toBe(2);
      expect(v).toMatchObject({ blocked: accessMessage('LICENCE_EXPIRED'), offline: false });
    });

    it('concurrent checks share one request', async () => {
      const { c, ports, state } = setup({ inbox: [] });
      await c.start();
      state.now += ACCESS_EVERY_MS;
      await Promise.all([c.checkAccessIfDue(), c.checkAccessIfDue(true), c.poll()]);
      expect(accessCalls(ports)).toBe(2);
    });

    it('restored_licence_refreshes_token_and_retries', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      await c.start();
      state.inboxError = { kod: 'BRAK_LICENCJI' };
      state.licensedToken = 'A2';
      state.inbox = [task(1), task(2)];
      const v = await c.poll();
      expect(state.refreshes).toBe(1);
      expect(v).toMatchObject({ offline: false, blocked: null });
      expect(v.tasks).toHaveLength(2);
      expect(accessCalls(ports)).toBe(2);
    });

    it('still_refused_after_refresh_blocks_with_licence_text', async () => {
      const { c, state } = setup({ inbox: [task(1)] });
      await c.start();
      state.inboxError = { kod: 'LICENCJA_WYGASLA' };
      const v = await c.poll();
      expect(state.refreshes).toBe(1);
      expect(v).toMatchObject({ offline: false, blocked: accessMessage('LICENCE_EXPIRED') });
      expect(v.tasks).toHaveLength(1);
    });

    it('task action refused for licence refreshes the token and retries once', async () => {
      const { c, state } = setup({ inbox: [task(1)] });
      await c.start();
      state.inboxError = { kod: 'BRAK_LICENCJI' };
      state.licensedToken = 'A2';
      expect(await c.handlers()['task.remove']!({ id: id(1) })).toEqual({ ok: true });
      expect(state.refreshes).toBe(1);
      state.licensedToken = 'nikt';
      await expect(c.handlers()['task.remove']!({ id: id(1) })).rejects.toMatchObject({ code: 'BRAK_LICENCJI' });
      expect(state.refreshes).toBe(2);
      expect(c.current().blocked).toBe(accessMessage('NO_LICENCE'));
    });

    it('unblocking refreshes the token before fetching the inbox', async () => {
      const { c, ports, state } = setup({ inbox: [task(1)] });
      state.access = { active: false, reason: 'NO_LICENCE' };
      await c.start();
      state.access = { active: true };
      await c.poll();
      expect(state.refreshes).toBe(1);
      const inbox = vi.mocked(ports.fetch).mock.calls.find(([u]) => String(u).endsWith('/skrzynka'))!;
      expect((inbox[1].headers as Record<string, string>).Authorization).toBe('Bearer A2');
    });

    it('blocking clears offline', async () => {
      const { c, state } = setup({ inbox: [] });
      state.access = new TypeError('offline');
      state.offline = true;
      await c.start();
      expect(c.current().offline).toBe(true);
      state.offline = false;
      state.access = { active: false, reason: 'ORG_SUSPENDED' };
      expect(await c.poll()).toMatchObject({ offline: false, blocked: accessMessage('ORG_SUSPENDED') });
    });

    it('a new session does not reuse an access check of the old one', async () => {
      const { c, ports, state } = setup({ inbox: [] });
      await c.start();
      let open!: () => void;
      state.accessGate = new Promise((r) => { open = r; });
      const old = c.checkAccessIfDue(true);
      await c.logout();
      const h = c.handlers();
      await h['login.sendCode']!({ email: 'm@x.pl' });
      await h['login.confirm']!({ code: '123456' });
      const fresh = c.poll();
      open();
      await Promise.all([old, fresh]);
      expect(accessCalls(ports)).toBe(3);
    });

    it('no access check when logged out', async () => {
      const { c, ports } = setup({ session: null });
      await c.start();
      await c.checkAccessIfDue(true);
      expect(ports.fetch).not.toHaveBeenCalled();
    });
  });
});
