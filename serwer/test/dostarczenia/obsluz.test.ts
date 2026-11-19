import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GithubPr } from '../../src/dostarczenia/github.js';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';

// GitHub replaced by an in-memory map; the Secrets Manager token by a flag.
const github = vi.hoisted(() => ({
  prs: new Map<string, unknown>(), token: 'tok' as string | null, fail: null as null | (() => Error), reads: [] as string[],
}));
vi.mock('../../src/dostarczenia/github.js', async (orig) => {
  const real = await orig<typeof import('../../src/dostarczenia/github.js')>();
  return {
    ...real,
    readToken: async () => github.token,
    githubFetchers: () => ({
      fetchPr: async (r: { repo: string; number: number }) => {
        if (github.fail) throw github.fail();
        github.reads.push(`${r.repo}#${r.number}`);
        return github.prs.get(`${r.repo}#${r.number}`) ?? null;
      },
      fetchStacked: async () => null,
    }),
  };
});

const { evaluateCompany, handler, shouldEvaluate, startWatch } = await import('../../src/dostarczenia/obsluz.js');
const { GithubAccessError } = await import('../../src/dostarczenia/github.js');
const { watchesOf } = await import('../../src/dane/dostarczenia.js');
const { skrzynka } = await import('../../src/dane/kolejka.js');
const { zapiszLoginGithub } = await import('../../src/dane/konfiguracja.js');

const tabela = ustawTabeleTestowa('cognifly-test-dostarczenia');
beforeAll(async () => {
  await tabela.utworz();
  await zapiszLoginGithub('f1', 'ania-gh', 'ania');
});
afterAll(() => tabela.usun());
beforeEach(() => {
  github.prs.clear();
  github.token = 'tok';
  github.fail = null;
  github.reads = [];
});

const pr = (number: number, over: Partial<GithubPr> = {}): GithubPr => ({
  number, state: 'OPEN', merged: false, headRefOid: 'a'.repeat(40), baseRefName: 'main', headRefName: `f${number}`,
  mergeable: 'MERGEABLE', reviewDecision: null, body: '', author: { login: 'ania-gh' },
  reviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
});
const accept = (number: number) =>
  startWatch({ firma: 'f1', repo: 'o/r', pr: number, reviewTaskId: 'zad_000000000001', reviewer: 'michal', acceptedSha: 'a'.repeat(40) });

describe('delivery watch', () => {
  test('ready PR → one "Dostarcz" task for author and reviewer (idempotent)', async () => {
    github.prs.set('o/r#10', pr(10));
    const r = await accept(10);
    expect(r).toMatchObject({ ready: true, reasons: [] });
    await evaluateCompany('f1');
    const forAnia = (await skrzynka('f1', 'ania')).filter((z) => z.opis.startsWith('Dostarcz PR #10'));
    const forMichal = (await skrzynka('f1', 'michal')).filter((z) => z.opis.startsWith('Dostarcz PR #10'));
    expect(forAnia).toHaveLength(1);
    expect(forMichal.map((z) => z.id)).toEqual(forAnia.map((z) => z.id));
    expect(forAnia[0]!.opis).toBe('Dostarcz PR #10 (repo o/r) — CI zielone, zależności scalone');
    expect((await watchesOf('f1')).find((w) => w.pr === 10)).toMatchObject({ status: 'ready', deliveryTaskId: forAnia[0]!.id });
  });

  test('waiting on a dependency, then ready once it is merged', async () => {
    github.prs.set('o/r#20', pr(20, { body: 'Zależy od: #21' }));
    github.prs.set('o/r#21', pr(21));
    expect(await accept(20)).toMatchObject({ ready: false, reasons: ['CZEKA_NA o/r#21'] });
    expect((await skrzynka('f1', 'michal')).some((z) => z.opis.startsWith('Dostarcz PR #20'))).toBe(false);
    github.prs.set('o/r#21', pr(21, { state: 'MERGED', merged: true }));
    await evaluateCompany('f1');
    expect((await skrzynka('f1', 'michal')).some((z) => z.opis.startsWith('Dostarcz PR #20'))).toBe(true);
  });

  test('merged root ends the watch; missing token waits with BRAK_TOKENU', async () => {
    github.prs.set('o/r#30', pr(30, { state: 'MERGED', merged: true }));
    await accept(30);
    expect((await watchesOf('f1')).find((w) => w.pr === 30)?.status).toBe('delivered');
    github.token = null;
    expect(await accept(31)).toMatchObject({ ready: false, reasons: ['BRAK_TOKENU'] });
  });

  test('rejected or rate-limited token gives its own reason, not ZALEZNOSC_NIEDOSTEPNA', async () => {
    github.fail = () => new GithubAccessError('TOKEN_NIEWAZNY');
    expect(await accept(32)).toMatchObject({ ready: false, reasons: ['TOKEN_NIEWAZNY'] });
    github.fail = () => new GithubAccessError('LIMIT_GITHUB');
    expect(await accept(33)).toMatchObject({ ready: false, reasons: ['LIMIT_GITHUB'] });
  });

  test('PR closed without merging ends the sweep; a signal from its repo revives it after reopening', async () => {
    github.prs.set('o/r#40', pr(40, { state: 'CLOSED' }));
    expect(await accept(40)).toMatchObject({ ready: false, reasons: ['ZAMKNIETY'] });
    expect((await watchesOf('f1')).find((w) => w.pr === 40)?.status).toBe('closed');
    github.reads = [];
    await evaluateCompany('f1');
    expect(github.reads).not.toContain('o/r#40');
    github.prs.set('o/r#40', pr(40));
    await handler({ detail: { firma: 'f1', repo: 'o/r' } });
    expect((await watchesOf('f1')).find((w) => w.pr === 40)?.status).toBe('ready');
  });

  test('a GitHub signal re-assesses only watches whose chain touches its repo', async () => {
    github.prs.set('o/r#50', pr(50, { body: 'Zależy od: inna/lib#3' }));
    github.prs.set('inna/lib#3', pr(3));
    await accept(50);
    expect((await watchesOf('f1')).find((w) => w.pr === 50)?.repos).toEqual(['o/r', 'inna/lib']);
    github.reads = [];
    await handler({ detail: { firma: 'f1', repo: 'zupelnie/obce' } });
    expect(github.reads).toEqual([]);
    await handler({ detail: { firma: 'f1', repo: 'inna/lib' } });
    expect(github.reads).toContain('o/r#50');
  });

  test('shouldEvaluate: delivered never, closed only on own repo, unknown chain always', () => {
    const w = { firma: 'f1', repo: 'O/R', pr: 1, reviewTaskId: 'z', reviewer: 'm', acceptedSha: 's', acceptedAt: 'a', reasons: [] };
    expect(shouldEvaluate({ ...w, status: 'delivered' })).toBe(false);
    expect(shouldEvaluate({ ...w, status: 'closed' })).toBe(false);
    expect(shouldEvaluate({ ...w, status: 'closed' }, 'o/r')).toBe(true);
    expect(shouldEvaluate({ ...w, status: 'waiting' }, 'x/y')).toBe(true);
    expect(shouldEvaluate({ ...w, status: 'waiting', repos: ['o/r'] }, 'x/y')).toBe(false);
    expect(shouldEvaluate({ ...w, status: 'waiting', repos: ['o/r'] })).toBe(true);
  });
});
