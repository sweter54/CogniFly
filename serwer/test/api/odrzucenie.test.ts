import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';

// No GitHub token: review requests are accepted without checking the PR.
vi.mock('../../src/dostarczenia/github.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dostarczenia/github.js')>()),
  readToken: async () => null,
}));

const { handler } = await import('../../src/api/index.js');
const { zapiszLoginGithub, zapiszOsobe, zapiszTozsamosc } = await import('../../src/dane/konfiguracja.js');
const { skrzynka, utworzZadanie, pobierzZadanie } = await import('../../src/dane/kolejka.js');

const tabela = ustawTabeleTestowa('cognifly-test-api-odrzucenie');
beforeAll(async () => {
  await tabela.utworz();
  for (const o of ['michal', 'ania', 'bartek']) {
    await zapiszTozsamosc(`sub-${o}`, 'f1', o);
    await zapiszOsobe('f1', o, { email: `${o}@x.pl`, rola: 'czlonek' });
  }
  await zapiszLoginGithub('f1', 'ania-gh', 'ania');
});
afterAll(() => tabela.usun());

async function wywolaj(routeKey: string, o: { sub?: string; body?: unknown; id?: string } = {}) {
  const r = await handler({
    routeKey, headers: {}, queryStringParameters: {}, pathParameters: o.id ? { id: o.id } : {},
    body: o.body === undefined ? null : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    requestContext: { authorizer: { jwt: { claims: { sub: `sub-${o.sub ?? 'michal'}` } } } },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const zglos = async (recenzenci: string[]) =>
  (await wywolaj('POST /recenzje', { body: { repo: 'o/r', pr: 4, recenzenci } })).body.zadanie as { id: string; nadawca?: string };
const odrzuc = (id: string, sub: string, powod: unknown = 'Nie znam tego modułu') =>
  wywolaj('POST /zadania/{id}/odrzuc', { id, sub, body: { powod } });
const ids = async (osoba: string) => (await skrzynka('f1', osoba)).map((z) => z.id);

describe('POST /zadania/{id}/odrzuc', () => {
  test('a review request remembers its sender; rejecting returns it to the sender with the reason', async () => {
    const z = await zglos(['ania']);
    expect(z.nadawca).toBe('michal');
    const r = await odrzuc(z.id, 'ania');
    expect(r.status).toBe(200);
    expect(r.body.zadanie).toMatchObject({
      stan: 'odrzucone', wlasciciel: 'michal', kandydaci: ['michal'], postep: 'Odrzucone przez ania',
      odrzucenie: { osoba: 'ania', powod: 'Nie znam tego modułu' },
    });
    expect(await ids('ania')).not.toContain(z.id);
    expect(await ids('michal')).toContain(z.id);
  });

  test('with several reviewers only the rejecting one drops out; the last one returns it', async () => {
    const z = await zglos(['ania', 'bartek']);
    expect((await odrzuc(z.id, 'ania')).body.zadanie).toMatchObject({ stan: 'nowe', kandydaci: ['bartek'] });
    expect(await ids('ania')).not.toContain(z.id);
    expect((await odrzuc(z.id, 'bartek')).body.zadanie).toMatchObject({ stan: 'odrzucone', wlasciciel: 'michal' });
  });

  test('the owner of a taken task may reject it; other candidates may not', async () => {
    const z = await zglos(['ania', 'bartek']);
    await wywolaj('POST /zadania/{id}/biore', { id: z.id, sub: 'bartek' });
    expect(await odrzuc(z.id, 'ania')).toMatchObject({ status: 403, body: { kod: 'BRAK_DOSTEPU' } });
    expect((await odrzuc(z.id, 'bartek')).body.zadanie).toMatchObject({ stan: 'odrzucone', kandydaci: ['michal'] });
    expect(await ids('bartek')).not.toContain(z.id);
  });

  test('rejects tasks without a sender, bad reasons, outsiders and repeated rejections', async () => {
    const bez = await utworzZadanie('f1', 'evt_000000000000000000000009', ['ania'], { opis: 'Z reguły' });
    expect(await odrzuc(bez.id, 'ania')).toMatchObject({ status: 409, body: { kod: 'BRAK_NADAWCY' } });
    const z = await zglos(['ania']);
    for (const zly of ['', '   ', 'x'.repeat(201), 5, 'a\u0007b']) {
      expect(await odrzuc(z.id, 'ania', zly)).toMatchObject({ status: 400, body: { kod: 'ZLY_POWOD' } });
    }
    expect(await odrzuc(z.id, 'bartek')).toMatchObject({ status: 403, body: { kod: 'BRAK_DOSTEPU' } });
    await odrzuc(z.id, 'ania');
    expect(await odrzuc(z.id, 'michal')).toMatchObject({ status: 409, body: { kod: 'KONFLIKT' } });
  });
});

describe('after a rejection', () => {
  test('the sender deletes it: state usuniete; nobody else can, nor for other states', async () => {
    const z = await zglos(['ania']);
    expect(await wywolaj('POST /zadania/{id}/usun', { id: z.id })).toMatchObject({ status: 409, body: { kod: 'KONFLIKT' } });
    await odrzuc(z.id, 'ania');
    expect(await wywolaj('POST /zadania/{id}/usun', { id: z.id, sub: 'ania' })).toMatchObject({ status: 403 });
    const r = await wywolaj('POST /zadania/{id}/usun', { id: z.id });
    expect(r).toMatchObject({ status: 200, body: { zadanie: { stan: 'usuniete' } } });
  });

  test('the sender hands it to another person: new for them, sender kept, reason cleared', async () => {
    const z = await zglos(['ania']);
    await odrzuc(z.id, 'ania');
    expect(await wywolaj('POST /zadania/{id}/przekaz', { id: z.id, body: { doOsoby: 'obcy' } }))
      .toMatchObject({ status: 409, body: { kod: 'BRAK_OSOBY' } });
    const r = await wywolaj('POST /zadania/{id}/przekaz', { id: z.id, body: { doOsoby: 'bartek' } });
    expect(r.body.zadanie).toMatchObject({ stan: 'nowe', kandydaci: ['bartek'], nadawca: 'michal' });
    expect(r.body.zadanie.odrzucenie).toBeUndefined();
    expect(r.body.zadanie.wlasciciel).toBeUndefined();
    expect((await pobierzZadanie('f1', z.id))!.odrzucenie).toBeUndefined();
    expect(await ids('bartek')).toContain(z.id);
    expect(await ids('michal')).not.toContain(z.id);
  });

  test('a CR handover by GitHub login makes the reviewer the sender', async () => {
    const z = await zglos(['bartek']);
    await wywolaj('POST /zadania/{id}/biore', { id: z.id, sub: 'bartek' });
    const r = await wywolaj('POST /zadania/{id}/przekaz', { id: z.id, sub: 'bartek', body: { doLoginu: 'ania-gh' } });
    expect(r.body.zadanie).toMatchObject({ kandydaci: ['ania'], nadawca: 'bartek' });
  });

  test('a rejected task counts in the session summary of the sender', async () => {
    const z = await zglos(['ania']);
    await odrzuc(z.id, 'ania');
    expect((await wywolaj('GET /podsumowanie')).body.linia).toContain('Prośba o recenzję PR #4');
  });
});

describe('POST /zadania/{id}/watek', () => {
  const W = 'local_1fb5034c-8723-4c40-85c5-981eca105464';
  test('remembers the Claude thread per person and returns it only in their inbox', async () => {
    const z = await zglos(['ania', 'bartek']);
    expect((await wywolaj('POST /zadania/{id}/watek', { id: z.id, sub: 'ania', body: { watek: W } })).status).toBe(200);
    const ania = (await wywolaj('GET /skrzynka', { sub: 'ania' })).body.zadania.find((t: any) => t.id === z.id);
    const bartek = (await wywolaj('GET /skrzynka', { sub: 'bartek' })).body.zadania.find((t: any) => t.id === z.id);
    expect(ania.watek).toBe(W);
    expect(bartek.watek).toBeUndefined();
  });

  test('accepts only a Claude Desktop session id, and only from candidates or the owner', async () => {
    const z = await zglos(['ania']);
    for (const zly of ['', 'local_x', `${W}&q=1`, 'claude://code', 7]) {
      expect(await wywolaj('POST /zadania/{id}/watek', { id: z.id, sub: 'ania', body: { watek: zly } }))
        .toMatchObject({ status: 400, body: { kod: 'ZLY_WATEK' } });
    }
    expect(await wywolaj('POST /zadania/{id}/watek', { id: z.id, sub: 'bartek', body: { watek: W } }))
      .toMatchObject({ status: 403 });
  });
});
