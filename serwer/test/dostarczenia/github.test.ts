import { describe, expect, test, vi } from 'vitest';
import { buildGraph, graphql, MAX_CHAIN, nodeFromPr, type GithubAccessError, type GithubPr } from '../../src/dostarczenia/github.js';
import { assessChain } from '../../src/dostarczenia/ocena.js';
import { refKey } from '../../src/dostarczenia/zaleznosci.js';

const pr = (over: Partial<GithubPr> = {}): GithubPr => ({
  number: 7, state: 'OPEN', merged: false, headRefOid: 'h1', baseRefName: 'main', headRefName: 'feat',
  mergeable: 'MERGEABLE', reviewDecision: null, body: '', author: { login: 'ania' },
  reviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
});

describe('graphql: token problems are not "PR invisible"', () => {
  const answer = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  test('404 → null (PR not visible); 401/403/429 → GithubAccessError with its reason', async () => {
    expect(await graphql('t', 'q', {}, answer(404))).toBeNull();
    const reason = (f: typeof fetch) => graphql('t', 'q', {}, f).then(() => null, (e: GithubAccessError) => e.reason);
    expect(await reason(answer(401))).toBe('TOKEN_NIEWAZNY');
    expect(await reason(answer(403))).toBe('TOKEN_BEZ_UPRAWNIEN');
    expect(await reason(answer(403, { 'x-ratelimit-remaining': '0' }))).toBe('LIMIT_GITHUB');
    expect(await reason(answer(403, { 'retry-after': '60' }))).toBe('LIMIT_GITHUB');
    expect(await reason(answer(429))).toBe('LIMIT_GITHUB');
    expect(await reason(answer(200, {}, { errors: [{ type: 'RATE_LIMITED' }] }))).toBe('LIMIT_GITHUB');
    expect(await graphql('t', 'q', {}, answer(200, {}, { errors: [{ type: 'NOT_FOUND' }] }))).toBeNull();
  });
});

describe('nodeFromPr', () => {
  test('compares review and acceptance times as dates, not strings (milliseconds vs none)', () => {
    const ref = { repo: 'o/r', number: 7 };
    const reviews = { nodes: [{ submittedAt: '2026-11-17T10:00:00Z' }] };
    expect(nodeFromPr(ref, pr({ reviews }), { sha: 'h1', at: '2026-11-17T10:00:00.123Z' }, null).changesRequestedAfterAcceptance).toBe(false);
    const later = { nodes: [{ submittedAt: '2026-11-17T10:00:01Z' }] };
    expect(nodeFromPr(ref, pr({ reviews: later }), { sha: 'h1', at: '2026-11-17T10:00:00.999Z' }, null).changesRequestedAfterAcceptance).toBe(true);
  });
  const ref = { repo: 'o/r', number: 7 };
  test('maps GitHub states onto the chain node', () => {
    expect(nodeFromPr(ref, pr(), { sha: 'h1', at: '2026-11-17T10:00:00Z' }, null)).toEqual({
      ref, open: true, merged: false, headSha: 'h1', mergeable: true, ci: 'success', reviewDecision: null,
      changesRequestedAfterAcceptance: false, acceptedSha: 'h1', deps: [], author: 'ania',
    });
  });
  test('CI rollup: none = success, pending/expected = pending, failure/error = failure; conflicts and unknown', () => {
    expect(nodeFromPr(ref, pr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), null, null).ci).toBe('success');
    expect(nodeFromPr(ref, pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'EXPECTED' } } }] } }), null, null).ci).toBe('pending');
    expect(nodeFromPr(ref, pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] } }), null, null).ci).toBe('failure');
    expect(nodeFromPr(ref, pr({ mergeable: 'CONFLICTING' }), null, null).mergeable).toBe(false);
    expect(nodeFromPr(ref, pr({ mergeable: 'UNKNOWN' }), null, null).mergeable).toBeNull();
  });
  test('change requests after acceptance count; earlier ones do not', () => {
    const reviews = { nodes: [{ submittedAt: '2026-11-17T09:00:00Z' }, { submittedAt: '2026-11-17T11:00:00Z' }] };
    expect(nodeFromPr(ref, pr({ reviews }), { sha: 'h1', at: '2026-11-17T10:00:00Z' }, null).changesRequestedAfterAcceptance).toBe(true);
    expect(nodeFromPr(ref, pr({ reviews: { nodes: [reviews.nodes[0]!] } }), { sha: 'h1', at: '2026-11-17T10:00:00Z' }, null).changesRequestedAfterAcceptance).toBe(false);
  });
  test('deps from the description plus the PR it is stacked on', () => {
    const n = nodeFromPr(ref, pr({ body: 'Zależy od: inne/repo#3' }), null, { repo: 'o/r', number: 5 });
    expect(n.deps).toEqual([{ repo: 'inne/repo', number: 3 }, { repo: 'o/r', number: 5 }]);
  });
});

describe('buildGraph', () => {
  test('follows dependencies, records unreadable ones as absent and stops on cycles', async () => {
    const data: Record<string, GithubPr | null> = {
      'o/r#1': pr({ number: 1, body: 'Zależy od: #2, tajne/repo#9' }),
      'o/r#2': pr({ number: 2, body: 'Zależy od: #1' }),
      'tajne/repo#9': null,
    };
    const fetchPr = vi.fn(async (r: { repo: string; number: number }) => data[refKey(r)] ?? null);
    const stacked = vi.fn(async () => null);
    const { graph: g } = await buildGraph({ repo: 'o/r', number: 1 }, fetchPr, stacked, () => null);
    expect([...g.keys()].sort()).toEqual(['o/r#1', 'o/r#2']);
    expect(fetchPr).toHaveBeenCalledTimes(3);
  });

  test('does not follow dependencies of merged PRs (old history is no cycle)', async () => {
    const data: Record<string, GithubPr> = {
      'o/r#1': pr({ number: 1, body: 'Zależy od: #2' }),
      'o/r#2': pr({ number: 2, state: 'MERGED', merged: true, body: 'Zależy od: #1' }),
    };
    const { graph } = await buildGraph({ repo: 'o/r', number: 1 }, async (r) => data[refKey(r)] ?? null, async () => null, () => ({ sha: 'h1', at: '' }));
    expect(assessChain({ repo: 'o/r', number: 1 }, graph)).toMatchObject({ ready: true });
  });

  test('stops after MAX_CHAIN PRs and says the chain is too long', async () => {
    const body = 'Zależy od: ' + Array.from({ length: 60 }, (_, i) => `#${i + 2}`).join(', ');
    const fetchPr = vi.fn(async (r: { number: number }) => pr({ number: r.number, body: r.number === 1 ? body : '' }));
    const r = await buildGraph({ repo: 'o/r', number: 1 }, fetchPr, async () => null, () => null);
    expect(r.truncated).toBe(true);
    expect(fetchPr).toHaveBeenCalledTimes(MAX_CHAIN);
  });
});
