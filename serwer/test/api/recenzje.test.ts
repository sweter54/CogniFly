import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { claimsFor } from './claims.js';

// GitHub replaced by an in-memory map; token toggled per test.
const github = vi.hoisted(() => ({ prs: new Map<string, unknown>(), token: 'tok' as string | null }));
vi.mock('../../src/dostarczenia/github.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dostarczenia/github.js')>()),
  readToken: async () => github.token,
  githubFetchers: () => ({
    fetchPr: async (r: { repo: string; number: number }) => github.prs.get(`${r.repo}#${r.number}`) ?? null,
    fetchStacked: async () => null,
  }),
}));

const { handler } = await import('../../src/api/index.js');
const { zapiszLoginGithub, zapiszOsobe, zapiszTozsamosc } = await import('../../src/dane/konfiguracja.js');
const { skrzynka } = await import('../../src/dane/kolejka.js');

const tabela = ustawTabeleTestowa('cognifly-test-api-recenzje');
beforeAll(async () => {
  await tabela.utworz();
  await zapiszTozsamosc('sub-michal', 'f1', 'michal');
  await zapiszTozsamosc('sub-ania', 'f1', 'ania');
  await zapiszOsobe('f1', 'michal', { email: 'm@x.pl', rola: 'admin' });
  await zapiszOsobe('f1', 'ania', { email: 'a@x.pl', rola: 'czlonek' });
  await zapiszOsobe('f2', 'obca', { email: 'o@x.pl', rola: 'czlonek' });
  await zapiszLoginGithub('f1', 'Ania-GH', 'ania');
});
afterAll(() => tabela.usun());
beforeEach(() => {
  github.prs.clear();
  github.token = 'tok';
});

async function wywolaj(routeKey: string, o: { sub?: string; body?: string; id?: string } = {}) {
  const r = await handler({
    routeKey, headers: {}, queryStringParameters: {}, pathParameters: o.id ? { id: o.id } : {}, body: o.body ?? null,
    requestContext: { authorizer: { jwt: { claims: claimsFor(o.sub ?? 'sub-michal') } } },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const openPr = (state = 'OPEN') => ({ number: 4, state, merged: false, headRefOid: 'h', baseRefName: 'main', headRefName: 'f',
  mergeable: 'MERGEABLE', reviewDecision: null, body: '', author: { login: 'sweter54' }, reviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] } });

describe('GET /osoby', () => {
  test('lists company members with GitHub logins, without e-mails or other companies', async () => {
    const r = await wywolaj('GET /osoby');
    expect(r).toEqual({ status: 200, body: { osoby: [{ osoba: 'ania', github: 'ania-gh' }, { osoba: 'michal' }] } });
  });
});

describe('POST /recenzje', () => {
  const zglos = (b: unknown, sub?: string) => wywolaj('POST /recenzje', { body: JSON.stringify(b), sub });

  test('creates a review-request task for the chosen reviewers that opens a guided CR', async () => {
    github.prs.set('o/r#4', openPr());
    const r = await zglos({ repo: 'o/r', pr: 4, recenzenci: ['ania'] });
    expect(r.status).toBe(200);
    expect(r.body.zadanie).toMatchObject({ kandydaci: ['ania'], stan: 'nowe', opis: 'Prośba o recenzję PR #4 (repo o/r) od michal' });
    const forAnia = await skrzynka('f1', 'ania');
    expect(forAnia.map((z) => z.id)).toContain(r.body.zadanie.id);
    const d = await wywolaj('GET /zadania/{id}', { id: r.body.zadanie.id, sub: 'sub-ania' });
    expect(d.body.zdarzenie).toMatchObject({ typ: 'github.pr.prosba_o_review', podmiot: { repo: 'o/r', pr: 4, zglaszajacy: 'michal', autor: 'sweter54' } });
  });

  test('rejects reviewers outside the company, an empty list and bad input', async () => {
    expect(await zglos({ repo: 'o/r', pr: 4, recenzenci: ['obca'] })).toMatchObject({ status: 400, body: { kod: 'ZLI_RECENZENCI' } });
    expect((await zglos({ repo: 'o/r', pr: 4, recenzenci: [] })).status).toBe(400);
    expect((await zglos({ repo: 'zle', pr: 4, recenzenci: ['ania'] })).status).toBe(400);
    expect((await zglos({ repo: 'o/r', pr: 0, recenzenci: ['ania'] })).status).toBe(400);
  });

  test('with a token: missing PR → 404 BRAK_PR, closed PR → 409 PR_ZAMKNIETY; without a token: accepted unchecked', async () => {
    expect(await zglos({ repo: 'o/r', pr: 5, recenzenci: ['ania'] })).toMatchObject({ status: 404, body: { kod: 'BRAK_PR' } });
    github.prs.set('o/r#6', openPr('CLOSED'));
    expect(await zglos({ repo: 'o/r', pr: 6, recenzenci: ['ania'] })).toMatchObject({ status: 409, body: { kod: 'PR_ZAMKNIETY' } });
    github.token = null;
    expect((await zglos({ repo: 'o/r', pr: 7, recenzenci: ['ania'] })).status).toBe(200);
  });
});
