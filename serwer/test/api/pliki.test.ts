import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { zapiszTozsamosc } from '../../src/dane/konfiguracja.js';
import { doAkceptacji, utworzZadanie, wez } from '../../src/dane/kolejka.js';
import { jestUczestnikiem } from '../../src/api/zadania.js';
import { pliki } from '../../src/api/pliki.js';
import { handler } from '../../src/api/index.js';
import type { IntClient, WorkFilesResponse } from '../../src/heartwood/klient.js';

const tabela = ustawTabeleTestowa('cognifly-test-api-pliki');
let id = '';
beforeAll(async () => {
  await tabela.utworz();
  for (const o of ['ania', 'bartek', 'celina', 'obcy']) await zapiszTozsamosc(`sub-${o}`, 'f1', o);
  const z = await utworzZadanie('f1', 'evt_000000000000000000000001', ['ania', 'bartek'], { opis: 'X' });
  id = z.id;
  await wez('f1', id, 'ania');
});
afterAll(() => tabela.usun());

const lock = (space: string, by: string, path = 'a.txt') => ({
  space, ws: 'w', path, workId: 'w', folder: false, by, at: '2026-01-01T00:00:00Z', writer: by,
});
const ver = (space: string, author: string, seq: number) => ({
  space, path: 'a.txt', seq, author, at: '2026-01-02T00:00:00Z', kind: 'put' as const,
});
const odp = (o: Partial<WorkFilesResponse> = {}): WorkFilesResponse => ({
  writer: 'sub-ania', closed: false, locks: [], hiddenLocks: 0, versions: [], ...o,
});
const klient = (r: WorkFilesResponse) =>
  ({ getWorkFiles: vi.fn(async () => r) }) as unknown as IntClient & { getWorkFiles: ReturnType<typeof vi.fn> };
const kto = (osoba: string, firma = 'f1') => ({ sub: `sub-${osoba}`, firma, osoba });

describe('GET /zadania/{id}/pliki', () => {
  test('maps subs to person ids and reads the right work', async () => {
    const c = klient(odp({
      locks: [lock('ws:w', 'sub-ania')],
      versions: [ver('ws:w', 'sub-bartek', 7), ver('ws:w', 'sub-nieznany', 8)],
    }));
    const r = await pliki(kto('ania'), id, c);
    expect(c.getWorkFiles).toHaveBeenCalledWith('f1', `cognifly:${id}`);
    expect(r.body).toEqual({
      zadanie: id, pisze: 'ania', zamkniete: false,
      blokady: [{ przestrzen: 'ws:w', sciezka: 'a.txt', folder: false, kto: 'ania', kiedy: '2026-01-01T00:00:00Z' }],
      zmiany: [
        { przestrzen: 'ws:w', sciezka: 'a.txt', seq: 7, rodzaj: 'put', autor: 'bartek', kiedy: '2026-01-02T00:00:00Z' },
        { przestrzen: 'ws:w', sciezka: 'a.txt', seq: 8, rodzaj: 'put', autor: null, kiedy: '2026-01-02T00:00:00Z' },
      ],
    });
  });

  test("hides other people's private spaces, keeps the caller's own", async () => {
    const c = klient(odp({
      locks: [lock('user:sub-bartek', 'sub-bartek', 'sekret'), lock('user:sub-ania', 'sub-ania', 'moje')],
      versions: [ver('user:sub-bartek', 'sub-bartek', 1), ver('user:sub-ania', 'sub-ania', 2)],
    }));
    const r = await pliki(kto('ania'), id, c);
    expect(JSON.stringify(r.body)).not.toContain('sekret');
    expect(r.body).toMatchObject({
      blokady: [{ przestrzen: 'user:sub-ania' }], zmiany: [{ przestrzen: 'user:sub-ania', seq: 2 }],
    });
  });

  test('null writer and closed work', async () => {
    const r = await pliki(kto('bartek'), id, klient(odp({ writer: null, closed: true })));
    expect(r.body).toMatchObject({ pisze: null, zamkniete: true, blokady: [], zmiany: [] });
  });

  test('a candidate who is not the owner has access; a stranger gets 403', async () => {
    await expect(pliki(kto('bartek'), id, klient(odp()))).resolves.toMatchObject({ status: 200 });
    await expect(pliki(kto('celina'), id, klient(odp()))).rejects.toMatchObject({ status: 403, kod: 'BRAK_DOSTEPU' });
  });

  test('the acceptor has access', async () => {
    const z = await utworzZadanie('f1', 'evt_000000000000000000000002', ['ania'], { opis: 'Y' });
    await wez('f1', z.id, 'ania');
    await doAkceptacji('f1', z.id, 'ania', 'celina');
    await expect(pliki(kto('celina'), z.id, klient(odp()))).resolves.toMatchObject({ status: 200 });
  });

  test('shared rule: acceptor outside candidates counts, a stranger does not', () => {
    const z = { kandydaci: ['ania'], wlasciciel: 'ania', akceptujacy: 'celina' };
    expect(jestUczestnikiem(z, 'celina')).toBe(true);
    expect(jestUczestnikiem(z, 'ania')).toBe(true);
    expect(jestUczestnikiem({ ...z, wlasciciel: undefined }, 'bartek')).toBe(false);
  });

  test('GET /zadania/{id}: acceptor 200, non-participant 403 (as in pliki)', async () => {
    const z = await utworzZadanie('f1', 'evt_000000000000000000000003', ['ania'], { opis: 'Z' });
    await wez('f1', z.id, 'ania');
    await doAkceptacji('f1', z.id, 'ania', 'celina');
    const get = (sub: string) => handler({
      routeKey: 'GET /zadania/{id}', headers: {}, pathParameters: { id: z.id },
      requestContext: { authorizer: { jwt: { claims: { sub } } } },
    });
    expect((await get('sub-celina')).statusCode).toBe(200);
    expect((await get('sub-obcy')).statusCode).toBe(403);
    await expect(pliki(kto('obcy'), z.id, klient(odp()))).rejects.toMatchObject({ status: 403 });
  });

  test('unknown or malformed id -> 404, no client call', async () => {
    const c = klient(odp());
    await expect(pliki(kto('ania'), 'zad_ffffffffffff', c)).rejects.toMatchObject({ status: 404 });
    await expect(pliki(kto('ania'), 'zly', c)).rejects.toMatchObject({ status: 404 });
    await expect(pliki(kto('ania'), undefined, c)).rejects.toMatchObject({ status: 404 });
    expect(c.getWorkFiles).not.toHaveBeenCalled();
  });

  test('no Heartwood client -> 503 PLIKI_WYLACZONE', async () => {
    await expect(pliki(kto('ania'), id, null)).rejects.toMatchObject({ status: 503, kod: 'PLIKI_WYLACZONE' });
  });

  test('routed through the handler: 503 without HEARTWOOD_INT_URL', async () => {
    const r = await handler({
      routeKey: 'GET /zadania/{id}/pliki', headers: {}, pathParameters: { id },
      requestContext: { authorizer: { jwt: { claims: { sub: 'sub-ania' } } } },
    });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ kod: 'PLIKI_WYLACZONE' });
  });
});
