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
