import { describe, expect, it, vi } from 'vitest';
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
const goodSession = JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 3_600_000, email: 'm@x.pl' });

const ROOT = '/Users/m/Heartwood';

/** Stored session whose access token carries `sub`. */
const sessionOf = (sub: string) => JSON.stringify({ accessToken: jwt({ sub }), refreshToken: 'R', expiresAt: NOW + 3_600_000, email: 'm@x.pl' });
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
    if (/\/(odrzuc|usun|przekaz|akceptuj|do-poprawy|stan)$/.test(url)) return json(200, { zadanie: task(1, 'odrzucone') });
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
    now: () => NOW,
  };
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
      const { c, ports, hw } = setup({ inbox: [task(1)] });
      hw.state = 'disabled';
      hw.startError = 'DISABLED';
      const v = await c.start();
      expect(ports.heartwood.start).toHaveBeenCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, 'pilot');
      expect(v.tasks).toHaveLength(1);
      expect(v.files.info.state).toBe('disabled');
      expect(v.files.status).toBeNull();
      expect(hw.calls).toEqual([]);
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenCalledTimes(1);
    });

    it('running daemon: status is read at each poll and counted', async () => {
      const { c } = setup({ inbox: [] });
      const v = await c.start();
      expect(v.files.status?.connected).toBe(true);
      expect(v.files.counts).toEqual({ conflicts: 2, unsent: 7 });
      expect(await c.handlers()['files.get']!({})).toEqual(v.files);
    });

    it('a company change restarts the daemon with the new org', async () => {
      const { c, state, ports } = setup({ inbox: [] });
      state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
      await c.start();
      await c.handlers()['config.setCompany']!({ company: 'acme' });
      await c.poll();
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, 'acme');
    });

    it('lock refuses paths outside root without calling the daemon', async () => {
      const { c, hw } = setup({ inbox: [] });
      await c.start();
      hw.calls = [];
      hw.picked = [`${ROOT}/pilot/w1/a.docx`, '/Users/m/Desktop/x.docx'];
      await expect(c.handlers()['task.lockFiles']!({ id: lockId })).rejects.toMatchObject({ code: 'OUTSIDE' });
      expect(hw.calls).toEqual([]);
    });

    it('lockFiles locks the picked files per space with the work id and keeps no memory', async () => {
      const { c, hw, ports } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
      await c.start();
      hw.calls = [];
      expect(await c.handlers()['task.lockFiles']!({ id: lockId })).toEqual({ paths: [] });
      await expect(c.handlers()['task.lockFiles']!({ id: 'x' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
      expect(hw.calls).toEqual([]);
    });

    it('a daemon refusal surfaces as its code', async () => {
      const { c, hw } = setup({ inbox: [] });
      await c.start();
      hw.picked = [`${ROOT}/pilot/w1/a.docx`];
      hw.reply = () => ({ ok: false, code: 'LOCKED', message: 'Plik blokuje Ania.' });
      await expect(c.handlers()['task.lockFiles']!({ id: lockId })).rejects.toMatchObject({ code: 'LOCKED' });
    });

    it('task.files calls work-files with the work id, merges version pages and returns me', async () => {
      const { c, hw } = setup({ inbox: [], session: sessionOf('u-me') });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
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
      const { c, ports } = setup({ inbox: [] });
      await c.start();
      (ports.heartwood.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce('NOT_RUNNING');
      await expect(c.handlers()['files.history']!({ path: `${ROOT}/pilot/w1/a.docx` })).rejects.toMatchObject({ code: 'NOT_RUNNING' });
    });

    it('history, download and restore pass checked params to the daemon', async () => {
      const { c, hw } = setup({ inbox: [] });
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
      const { c, hw } = setup({ inbox: [] });
      await c.start();
      const h = c.handlers();
      expect(await h['files.select']!({ space: 'w1', topics: ['umowy'] })).toEqual({ ok: true });
      expect(await h['files.unselect']!({ space: 'w1', yes: true })).toEqual({ ok: true });
      expect(hw.calls).toContainEqual({ cmd: 'select', space: 'w1', topics: ['umowy'] });
      expect(hw.calls).toContainEqual({ cmd: 'unselect', space: 'w1', yes: true });
      await expect(h['files.select']!({ space: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('pickPath returns a picked file under root, null on cancel', async () => {
      const { c, hw } = setup({ inbox: [] });
      await c.start();
      expect(await c.handlers()['files.pickPath']!({})).toEqual({ path: null });
      hw.picked = [`${ROOT}/pilot/w1/a.docx`];
      expect(await c.handlers()['files.pickPath']!({})).toEqual({ path: `${ROOT}/pilot/w1/a.docx` });
    });

    it('a daemon refusal reaches the window with its code and Polish text', async () => {
      const { c, hw } = setup({ inbox: [] });
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
      const { c, ports, hw } = setup({ inbox: [] });
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
      const { c, state, ports, hw } = setup({ inbox: [] });
      state.firmy = [{ firma: 'pilot', osoba: 'michal' }, { firma: 'acme', osoba: 'mr' }];
      await c.start();
      expect(c.current().files.counts.conflicts).toBe(2);
      hw.startError = 'NO_EXE';
      await c.handlers()['config.setCompany']!({ company: 'acme' });
      await c.poll();
      expect(ports.heartwood.stop).toHaveBeenCalledTimes(1);
      expect(ports.heartwood.start).toHaveBeenLastCalledWith(DEFAULT_CONFIG.heartwoodUrl, DEFAULT_CONFIG.heartwoodWsUrl, 'acme');
      expect(c.current().files).toMatchObject({ status: null, counts: { conflicts: 0, unsent: 0 } });
      hw.startError = null;
      await c.poll();
      expect(c.current().files.counts.conflicts).toBe(2); // retried at the next poll
    });

    it('files.reveal opens the local folder of a selected space under the root', async () => {
      const { c, hw, ports } = setup({ inbox: [] });
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
      const { c, hw, ports } = setup({ inbox: [] });
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
      const { c, ports } = setup({ inbox: [] });
      await c.start();
      (ports.heartwood.call as ReturnType<typeof vi.fn>).mockRejectedValueOnce('TIMEOUT');
      await expect(c.handlers()['files.reveal']!({ space: 'ws:w1', folder: '' })).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(ports.revealFolder).not.toHaveBeenCalled();
    });

    it('task.focus shows the task in the inbox and checks the id', async () => {
      const { ports } = setup({ inbox: [task(1)] });
      ports.store.setItem('cognifly.config', JSON.stringify({ ...DEFAULT_CONFIG, workFolder: '/Users/m' }));
      const c = new Controller(ports);
      await c.start();
      expect(await c.handlers()['task.focus']!({ id: id(1) })).toEqual({ ok: true });
      expect(ports.showScreen).toHaveBeenLastCalledWith('inbox', id(1));
      await expect(c.handlers()['task.focus']!({ id: 'zle' })).rejects.toMatchObject({ code: 'BAD_TASK_ID' });
    });

    it('logout stops the daemon and clears the files view', async () => {
      const { c, ports } = setup({ inbox: [] });
      await c.start();
      await c.handlers()['session.logout']!({});
      expect(ports.heartwood.stop).toHaveBeenCalled();
      expect(c.current().files.status).toBeNull();
    });
  });
});
