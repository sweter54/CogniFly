import { describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../src/logic/cognito.js';
import { CognitoError, LoginRequiredError, NetworkError } from '../src/logic/errors.js';
import { SessionManager, subOf, type Session } from '../src/logic/session.js';
import { jwt, memoryVault } from './helpers.js';

const NOW = 10_000_000;
const CLIENT = 'klient1';
const session = (expiresAt: number): Session => ({ accessToken: 'A1', refreshToken: 'R1', expiresAt, email: 'a@b.pl', clientId: CLIENT });
const fresh: Tokens = { accessToken: 'A2', refreshToken: 'R1', expiresAt: NOW + 3_600_000 };

function setup(stored: Session | null, refresher = vi.fn(async (): Promise<Tokens> => fresh)) {
  const vault = memoryVault(stored ? JSON.stringify(stored) : null);
  return { vault, refresher, manager: new SessionManager(vault, refresher, CLIENT, () => NOW) };
}

describe('SessionManager', () => {
  it('session_of_other_client_is_dropped_and_vault_cleared', async () => {
    const { manager, vault } = setup({ ...session(NOW + 3_600_000), clientId: 'stary' });
    expect(await manager.current()).toBeNull();
    expect(vault.value()).toBeNull();
    await expect(manager.accessToken()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it('session_without_client_id_is_dropped', async () => {
    const { clientId: _omit, ...old } = session(NOW + 3_600_000);
    const { manager, vault } = setup(old as Session);
    expect(await manager.current()).toBeNull();
    expect(vault.value()).toBeNull();
  });

  it('start_and_refresh_store_client_id', async () => {
    const { manager, vault } = setup(null);
    await manager.start('x@y.pl', { ...fresh, expiresAt: NOW });
    expect(JSON.parse(vault.value()!).clientId).toBe(CLIENT);
    await manager.forceRefresh();
    expect(JSON.parse(vault.value()!)).toMatchObject({ accessToken: 'A2', clientId: CLIENT });
  });

  it('uses the stored token while it is valid for more than 5 min', async () => {
    const { manager, refresher } = setup(session(NOW + 301_000));
    expect(await manager.accessToken()).toBe('A1');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('refreshes when 5 min or less remain and stores the result', async () => {
    const { manager, refresher, vault } = setup(session(NOW + 300_000));
    expect(await manager.accessToken()).toBe('A2');
    expect(refresher).toHaveBeenCalledWith('R1');
    expect(JSON.parse(vault.value()!)).toEqual({ ...fresh, email: 'a@b.pl', clientId: CLIENT });
  });

  it('shares one refresh between concurrent callers', async () => {
    const { manager, refresher } = setup(session(NOW));
    expect(await Promise.all([manager.accessToken(), manager.forceRefresh()])).toEqual(['A2', 'A2']);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('keeps the session when offline during refresh', async () => {
    const { manager, vault } = setup(session(NOW), vi.fn(async () => { throw new NetworkError(); }));
    await expect(manager.accessToken()).rejects.toBeInstanceOf(NetworkError);
    expect(vault.value()).not.toBeNull();
    expect(await manager.current()).not.toBeNull();
  });

  it('keeps the session on other Cognito errors (throttling)', async () => {
    const { manager, vault } = setup(session(NOW), vi.fn(async () => { throw new CognitoError('TooManyRequestsException'); }));
    await expect(manager.accessToken()).rejects.toEqual(new CognitoError('TooManyRequestsException'));
    expect(vault.value()).not.toBeNull();
  });

  it.each(['NotAuthorizedException', 'UserNotFoundException'])('logs out on %s', async (code) => {
    const { manager, vault } = setup(session(NOW), vi.fn(async () => { throw new CognitoError(code); }));
    await expect(manager.accessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(vault.value()).toBeNull();
    expect(await manager.current()).toBeNull();
  });

  it('requires login without a session or with a corrupt vault value', async () => {
    await expect(setup(null).manager.accessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    const m = new SessionManager(memoryVault('{"accessToken":1}'), vi.fn(), CLIENT, () => NOW);
    await expect(m.accessToken()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it('start() stores tokens with the e-mail; logout() clears them', async () => {
    const { manager, vault } = setup(null);
    await manager.start('x@y.pl', fresh);
    expect(JSON.parse(vault.value()!)).toEqual({ ...fresh, email: 'x@y.pl', clientId: CLIENT });
    await manager.logout();
    expect(vault.value()).toBeNull();
  });

  it('a refresh that finishes after logout does not restore the session', async () => {
    let finish!: (t: Tokens) => void;
    const { manager, vault, refresher } = setup(session(NOW), vi.fn(() => new Promise<Tokens>((r) => { finish = r; })));
    const pending = manager.accessToken();
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(refresher).toHaveBeenCalled());
    await manager.logout();
    finish(fresh);
    await expect(pending).rejects.toBeInstanceOf(LoginRequiredError);
    expect(vault.value()).toBeNull();
  });
});

describe('subOf', () => {
  it('reads sub from a real JWT shape (base64url, unicode payload)', () => {
    expect(subOf(jwt({ sub: '0a1b2c3d-1111-2222-3333-444455556666', 'cognito:username': 'Żaneta' }))).toBe('0a1b2c3d-1111-2222-3333-444455556666');
  });

  it.each([
    ['empty', ''],
    ['not a JWT', 'A'],
    ['two parts', 'a.b'],
    ['bad base64', 'a.@@@.c'],
    ['not JSON', `a.${Buffer.from('nope').toString('base64url')}.c`],
    ['array payload', jwt([1])],
    ['no sub', jwt({ email: 'a@b.pl' })],
    ['numeric sub', jwt({ sub: 7 })],
    ['empty sub', jwt({ sub: '' })],
  ])('%s → null', (_name, token) => expect(subOf(token)).toBeNull());
});
