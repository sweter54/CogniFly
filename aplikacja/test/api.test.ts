import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/logic/api.js';
import { DEFAULT_CONFIG } from '../src/logic/config.js';
import { ApiError, LoginRequiredError } from '../src/logic/errors.js';
import { SessionManager } from '../src/logic/session.js';
import { header, memoryVault, scriptedFetch, type Scripted } from './helpers.js';

const NOW = 5_000_000;
const ID = 'zad_0123456789ab';
const task = (over: object = {}) => ({ id: ID, firma: 'pilot', zdarzenieId: 'evt_1', kandydaci: ['michal'], stan: 'nowe', utworzono: '2026-11-16T10:00:00Z', opis: 'Review PR #1', ...over });

function setup(script: Scripted[]) {
  const vault = memoryVault(JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 3_600_000, email: 'a@b.pl' }));
  const refresher = vi.fn(async () => ({ accessToken: 'A2', refreshToken: 'R1', expiresAt: NOW + 3_600_000 }));
  const f = scriptedFetch(script);
  const api = new ApiClient(DEFAULT_CONFIG, new SessionManager(vault, refresher, () => NOW), f.fetch);
  return { api, calls: f.calls, refresher, vault };
}

describe('ApiClient', () => {
  it('lists the inbox with auth and company headers, dropping malformed tasks', async () => {
    const { api, calls } = setup([{ status: 200, body: { zadania: [task(), { id: 'zly' }, task({ id: 'zad_' + 'f'.repeat(24) })] } }]);
    expect((await api.inbox()).map((t) => t.id)).toEqual([ID, 'zad_' + 'f'.repeat(24)]);
    expect(calls[0]!.url).toBe(`${DEFAULT_CONFIG.apiUrl}/skrzynka`);
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer A1');
    expect(header(calls[0]!, 'X-Cognifly-Firma')).toBe('pilot');
  });

  it('refreshes once after 401 and retries with the new token', async () => {
    const { api, calls, refresher } = setup([{ status: 401 }, { status: 200, body: { zadania: [] } }]);
    expect(await api.inbox()).toEqual([]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(header(calls[1]!, 'Authorization')).toBe('Bearer A2');
  });

  it('asks for login when the refreshed token is rejected too (session kept)', async () => {
    const { api, vault } = setup([{ status: 401 }, { status: 401 }]);
    await expect(api.inbox()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(vault.value()).not.toBeNull();
  });

  it('take: 200 → TAKEN, 409 → BUSY with owner', async () => {
    const { api, calls } = setup([
      { status: 200, body: { zadanie: task({ stan: 'wziete', wlasciciel: 'michal' }) } },
      { status: 409, body: { kod: 'ZAJETE', wlasciciel: 'szymon' } },
    ]);
    expect(await api.take(ID)).toMatchObject({ status: 'TAKEN', task: { wlasciciel: 'michal' } });
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${DEFAULT_CONFIG.apiUrl}/zadania/${ID}/biore`);
    expect(await api.take(ID)).toEqual({ status: 'BUSY', owner: 'szymon' });
  });

  it('rejects a malformed id without a request (no path injection)', async () => {
    const { api, calls } = setup([]);
    await expect(api.take('../skrzynka')).rejects.toEqual(new ApiError(404, 'NIE_ZNALEZIONO'));
    expect(calls).toHaveLength(0);
  });

  it('setState sends the state; unknown states fail locally', async () => {
    const { api, calls } = setup([{ status: 200, body: { zadanie: task({ stan: 'w_trakcie' }) } }]);
    expect((await api.setState(ID, 'w_trakcie')).stan).toBe('w_trakcie');
    expect(calls[0]!.body).toEqual({ stan: 'w_trakcie' });
    await expect(api.setState(ID, 'nowe' as never)).rejects.toEqual(new ApiError(400, 'ZLY_STAN'));
  });

  it('maps error bodies to ApiError codes', async () => {
    const { api } = setup([{ status: 403, body: { kod: 'BRAK_DOSTEPU' } }, { status: 500, raw: 'x' }]);
    await expect(api.inbox()).rejects.toEqual(new ApiError(403, 'BRAK_DOSTEPU'));
    await expect(api.inbox()).rejects.toEqual(new ApiError(500, 'HTTP_500'));
  });

  it('me: lists memberships from GET /ja, dropping malformed ones', async () => {
    const { api, calls } = setup([{ status: 200, body: { firmy: [{ firma: 'pilot', osoba: 'michal' }, { firma: '', osoba: 'x' }, 'zle'] } }]);
    expect(await api.me()).toEqual([{ firma: 'pilot', osoba: 'michal' }]);
    expect(calls[0]!.url).toBe(`${DEFAULT_CONFIG.apiUrl}/ja`);
  });

  it('people: GET /osoby; requestReview: POST /recenzje with reviewers', async () => {
    const { api, calls } = setup([
      { status: 200, body: { osoby: [{ osoba: 'ania', github: 'ania-gh' }, { osoba: 'michal' }, { zle: 1 }] } },
      { status: 200, body: { zadanie: task({ stan: 'nowe' }) } },
      { status: 409, body: { kod: 'PR_ZAMKNIETY' } },
    ]);
    expect(await api.people()).toEqual([{ osoba: 'ania', github: 'ania-gh' }, { osoba: 'michal' }]);
    expect((await api.requestReview('o/r', 4, ['ania'])).id).toBe(ID);
    expect(calls[1]!.body).toEqual({ repo: 'o/r', pr: 4, recenzenci: ['ania'] });
    await expect(api.requestReview('o/r', 4, ['ania'])).rejects.toEqual(new ApiError(409, 'PR_ZAMKNIETY'));
  });

  it('requestReview validates locally before any request', async () => {
    const { api, calls } = setup([]);
    await expect(api.requestReview('zle', 4, ['ania'])).rejects.toMatchObject({ code: 'ZLE_REPO' });
    await expect(api.requestReview('o/r', 0, ['ania'])).rejects.toMatchObject({ code: 'ZLY_PR' });
    await expect(api.requestReview('o/r', 4, [])).rejects.toMatchObject({ code: 'ZLI_RECENZENCI' });
    expect(calls).toHaveLength(0);
  });
});
