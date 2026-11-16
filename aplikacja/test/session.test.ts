import { describe, expect, it, vi } from 'vitest';
import type { Tokens } from '../src/logic/cognito.js';
import { CognitoError, LoginRequiredError, NetworkError } from '../src/logic/errors.js';
import { SessionManager, type Session } from '../src/logic/session.js';
import { memoryVault } from './helpers.js';

const NOW = 10_000_000;
const session = (expiresAt: number): Session => ({ accessToken: 'A1', refreshToken: 'R1', expiresAt, email: 'a@b.pl' });
const fresh: Tokens = { accessToken: 'A2', refreshToken: 'R1', expiresAt: NOW + 3_600_000 };

function setup(stored: Session | null, refresher = vi.fn(async (): Promise<Tokens> => fresh)) {
  const vault = memoryVault(stored ? JSON.stringify(stored) : null);
  return { vault, refresher, manager: new SessionManager(vault, refresher, () => NOW) };
}

describe('SessionManager', () => {
  it('uses the stored token while it is valid for more than 60 s', async () => {
    const { manager, refresher } = setup(session(NOW + 61_000));
    expect(await manager.accessToken()).toBe('A1');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('refreshes when 60 s or less remain and stores the result', async () => {
    const { manager, refresher, vault } = setup(session(NOW + 60_000));
    expect(await manager.accessToken()).toBe('A2');
    expect(refresher).toHaveBeenCalledWith('R1');
    expect(JSON.parse(vault.value()!)).toEqual({ ...fresh, email: 'a@b.pl' });
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
    const m = new SessionManager(memoryVault('{"accessToken":1}'), vi.fn(), () => NOW);
    await expect(m.accessToken()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it('start() stores tokens with the e-mail; logout() clears them', async () => {
    const { manager, vault } = setup(null);
    await manager.start('x@y.pl', fresh);
    expect(JSON.parse(vault.value()!)).toEqual({ ...fresh, email: 'x@y.pl' });
    await manager.logout();
    expect(vault.value()).toBeNull();
  });
});
