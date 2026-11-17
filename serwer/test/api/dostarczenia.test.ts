import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';

const github = vi.hoisted(() => ({ prs: new Map<string, unknown>() }));
vi.mock('../../src/dostarczenia/github.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dostarczenia/github.js')>()),
  readToken: async () => 'tok',
  githubFetchers: () => ({
    fetchPr: async (r: { repo: string; number: number }) => github.prs.get(`${r.repo}#${r.number}`) ?? null,
    fetchStacked: async () => null,
  }),
}));

const { handler } = await import('../../src/api/index.js');
const { zapiszZdarzenie } = await import('../../src/dane/historia.js');
const { idZdarzenia } = await import('@cognifly/wspolne');
type Zdarzenie = import('@cognifly/wspolne').Zdarzenie;
const { zapiszTozsamosc } = await import('../../src/dane/konfiguracja.js');
const { utworzZadanie, wez } = await import('../../src/dane/kolejka.js');

const tabela = ustawTabeleTestowa('cognifly-test-api-dostarczenia');
beforeAll(async () => {
  await tabela.utworz();
  await zapiszTozsamosc('sub-michal', 'f1', 'michal');
  await zapiszTozsamosc('sub-ania', 'f1', 'ania');
});
afterAll(() => tabela.usun());

async function wywolaj(routeKey: string, o: { sub?: string; body?: string; q?: Record<string, string> } = {}) {
  const r = await handler({
    routeKey, headers: {}, queryStringParameters: o.q ?? {}, pathParameters: {}, body: o.body ?? null,
    requestContext: { authorizer: { jwt: { claims: { sub: o.sub ?? 'sub-michal' } } } },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const SHA = 'b'.repeat(40);
const prOk = { number: 5, state: 'OPEN', merged: false, headRefOid: SHA, baseRefName: 'main', headRefName: 'f', mergeable: 'MERGEABLE',
  reviewDecision: null, body: '', author: { login: 'x' }, reviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };

describe('POST /dostarczenia', () => {
  test('owner of the CR task starts the watch and gets the first assessment', async () => {
    github.prs.set('o/r#5', prOk);
    const z = await utworzZadanie('f1', 'evt_' + '1'.repeat(24), ['michal', 'ania'], { opis: 'CR' });
    await wez('f1', z.id, 'michal');
    const body = JSON.stringify({ repo: 'o/r', pr: 5, zadanieId: z.id, sha: SHA });
    expect((await wywolaj('POST /dostarczenia', { sub: 'sub-ania', body })).status).toBe(403);
    expect(await wywolaj('POST /dostarczenia', { body })).toMatchObject({ status: 200, body: { ocena: { ready: true, reasons: [] } } });
  });
  test('a task whose event names another repo/PR cannot start a watch (403 INNY_PR)', async () => {
    github.prs.set('o/r#8', { ...prOk, number: 8 });
    const zdarzenie: Zdarzenie = {
      id: idZdarzenia('github', 'cr-inny-pr'), firma: 'f1', zrodlo: 'github', typ: 'github.pr.prosba_o_review',
      czas: new Date(Date.now() - 5_000).toISOString(), podmiot: { repo: 'O/R', pr: 7 }, opis: 'CR', wymagaPracy: true,
    };
    await zapiszZdarzenie(zdarzenie);
    const z = await utworzZadanie('f1', zdarzenie.id, ['michal'], { opis: 'CR' });
    await wez('f1', z.id, 'michal');
    const start = (repo: string, pr: number) => wywolaj('POST /dostarczenia', { body: JSON.stringify({ repo, pr, zadanieId: z.id, sha: SHA }) });
    expect(await start('o/r', 8)).toMatchObject({ status: 403, body: { kod: 'INNY_PR' } });
    expect(await start('o/inne', 7)).toMatchObject({ status: 403, body: { kod: 'INNY_PR' } });
    github.prs.set('o/r#7', { ...prOk, number: 7 });
    expect((await start('o/r', 7)).status).toBe(200);
  });
  test('rejects bad repo, PR number, sha and unknown task', async () => {
    const z = await utworzZadanie('f1', 'evt_' + '2'.repeat(24), ['michal'], { opis: 'CR' });
    await wez('f1', z.id, 'michal');
    const zle = [
      { repo: 'zly', pr: 5, zadanieId: z.id, sha: SHA },
      { repo: 'o/r', pr: 0, zadanieId: z.id, sha: SHA },
      { repo: 'o/r', pr: 5, zadanieId: z.id, sha: 'xyz' },
    ];
    for (const b of zle) expect((await wywolaj('POST /dostarczenia', { body: JSON.stringify(b) })).status).toBe(400);
    expect((await wywolaj('POST /dostarczenia', { body: JSON.stringify({ repo: 'o/r', pr: 5, zadanieId: 'zad_' + 'e'.repeat(12), sha: SHA }) })).status).toBe(404);
  });
});

describe('GET /dostarczenia/ocena', () => {
  test('assesses any PR for a member (not accepted → NIE_ZAAKCEPTOWANY)', async () => {
    github.prs.set('o/r#6', { ...prOk, number: 6 });
    expect(await wywolaj('GET /dostarczenia/ocena', { q: { repo: 'o/r', pr: '6' } }))
      .toMatchObject({ status: 200, body: { ocena: { ready: false, reasons: ['NIE_ZAAKCEPTOWANY'] } } });
    expect((await wywolaj('GET /dostarczenia/ocena', { q: { repo: 'o/r', pr: 'x' } })).status).toBe(400);
  });
});
