import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GithubPr } from '../../src/dostarczenia/github.js';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';

// GitHub replaced by an in-memory map; the Secrets Manager token by a flag.
const github = vi.hoisted(() => ({ prs: new Map<string, unknown>(), token: 'tok' as string | null }));
vi.mock('../../src/dostarczenia/github.js', async (orig) => {
  const real = await orig<typeof import('../../src/dostarczenia/github.js')>();
  return {
    ...real,
    readToken: async () => github.token,
    githubFetchers: () => ({
      fetchPr: async (r: { repo: string; number: number }) => github.prs.get(`${r.repo}#${r.number}`) ?? null,
      fetchStacked: async () => null,
    }),
  };
});

const { evaluateCompany, startWatch } = await import('../../src/dostarczenia/obsluz.js');
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
});
