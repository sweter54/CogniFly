import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';

vi.mock('../../src/dostarczenia/github.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dostarczenia/github.js')>()),
  readToken: async () => null,
}));

const { handler } = await import('../../src/api/index.js');
const { zapiszOsobe, zapiszTozsamosc } = await import('../../src/dane/konfiguracja.js');
const { skrzynka, utworzZadanie } = await import('../../src/dane/kolejka.js');

const tabela = ustawTabeleTestowa('cognifly-test-api-akceptacja');
beforeAll(async () => {
  await tabela.utworz();
  for (const o of ['michal', 'ania', 'bartek']) {
    await zapiszTozsamosc(`sub-${o}`, 'f1', o);
    await zapiszOsobe('f1', o, { email: `${o}@x.pl`, rola: 'czlonek' });
  }
});
afterAll(() => tabela.usun());

async function wywolaj(routeKey: string, o: { sub?: string; body?: unknown; id?: string } = {}) {
  const r = await handler({
    routeKey, headers: {}, queryStringParameters: {}, pathParameters: o.id ? { id: o.id } : {},
    body: o.body === undefined ? null : JSON.stringify(o.body),
    requestContext: { authorizer: { jwt: { claims: { sub: `sub-${o.sub ?? 'michal'}` } } } },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
/** A task taken by ania (from a rule: no sender unless given). */
async function wziete(nadawca?: string) {
  const z = await utworzZadanie('f1', 'evt_000000000000000000000007', ['ania'], { opis: 'Zrób X', ...(nadawca ? { nadawca } : {}) });
  await wywolaj('POST /zadania/{id}/biore', { id: z.id, sub: 'ania' });
  return z.id;
}
const doAkceptacji = (id: string, akceptujacy?: string) =>
  wywolaj('POST /zadania/{id}/stan', { id, sub: 'ania', body: { stan: 'do_akceptacji', ...(akceptujacy ? { akceptujacy } : {}) } });
const ids = async (osoba: string) => (await skrzynka('f1', osoba)).map((z) => z.id);

describe('do akceptacji przez wskazaną osobę', () => {
  test('the owner names the acceptor; the task lands in their inbox', async () => {
    const id = await wziete();
    const r = await doAkceptacji(id, 'bartek');
    expect(r.status).toBe(200);
    expect(r.body.zadanie).toMatchObject({ stan: 'do_akceptacji', akceptujacy: 'bartek', wlasciciel: 'ania' });
    expect(r.body.zadanie.kandydaci).toEqual(expect.arrayContaining(['ania', 'bartek']));
    expect(await ids('bartek')).toContain(id);
    expect((await wywolaj('GET /zadania/{id}', { id, sub: 'bartek' })).status).toBe(200);
    expect((await wywolaj('GET /podsumowanie', { sub: 'bartek' })).body.linia).toContain('Zrób X');
  });

  test('without a name the sender accepts; without both it is refused', async () => {
    expect((await doAkceptacji(await wziete('michal'))).body.zadanie).toMatchObject({ akceptujacy: 'michal' });
    expect(await doAkceptacji(await wziete())).toMatchObject({ status: 400, body: { kod: 'BRAK_AKCEPTUJACEGO' } });
  });

  test('the acceptor must be another member of the company', async () => {
    const id = await wziete();
    expect(await doAkceptacji(id, 'obcy')).toMatchObject({ status: 400, body: { kod: 'ZLY_AKCEPTUJACY' } });
    expect(await doAkceptacji(id, 'ania')).toMatchObject({ status: 400, body: { kod: 'ZLY_AKCEPTUJACY' } });
  });

  test('the acceptor accepts: done; nobody else can', async () => {
    const id = await wziete();
    await doAkceptacji(id, 'bartek');
    expect(await wywolaj('POST /zadania/{id}/akceptuj', { id, sub: 'ania' })).toMatchObject({ status: 403 });
    const r = await wywolaj('POST /zadania/{id}/akceptuj', { id, sub: 'bartek' });
    expect(r.body.zadanie).toMatchObject({ stan: 'zrobione', postep: 'Zaakceptowane przez bartek' });
    expect(await wywolaj('POST /zadania/{id}/akceptuj', { id, sub: 'bartek' })).toMatchObject({ status: 409 });
  });

  test('the acceptor sends it back with a reason: owner works on it again', async () => {
    const id = await wziete();
    await doAkceptacji(id, 'bartek');
    expect(await wywolaj('POST /zadania/{id}/do-poprawy', { id, sub: 'bartek', body: { powod: '' } }))
      .toMatchObject({ status: 400, body: { kod: 'ZLY_POWOD' } });
    const r = await wywolaj('POST /zadania/{id}/do-poprawy', { id, sub: 'bartek', body: { powod: 'Brak testów' } });
    expect(r.body.zadanie).toMatchObject({ stan: 'w_trakcie', wlasciciel: 'ania', postep: 'Do poprawy (bartek)', uwagi: { osoba: 'bartek', powod: 'Brak testów' } });
    expect(r.body.zadanie.akceptujacy).toBeUndefined();
    const again = await doAkceptacji(id, 'bartek');
    expect(again.body.zadanie.uwagi).toBeUndefined();
    expect(again.body.zadanie.akceptujacy).toBe('bartek');
  });

  test('the owner moving the task on clears the acceptor', async () => {
    const id = await wziete();
    await doAkceptacji(id, 'bartek');
    const r = await wywolaj('POST /zadania/{id}/stan', { id, sub: 'ania', body: { stan: 'w_trakcie' } });
    expect(r.body.zadanie.akceptujacy).toBeUndefined();
    expect(await wywolaj('POST /zadania/{id}/akceptuj', { id, sub: 'bartek' })).toMatchObject({ status: 409 });
  });
});
