import { describe, expect, test, vi } from 'vitest';
import { buildGraph, nodeFromPr, type GithubPr } from '../../src/dostarczenia/github.js';
import { refKey } from '../../src/dostarczenia/zaleznosci.js';

const pr = (over: Partial<GithubPr> = {}): GithubPr => ({
  number: 7, state: 'OPEN', merged: false, headRefOid: 'h1', baseRefName: 'main', headRefName: 'feat',
  mergeable: 'MERGEABLE', reviewDecision: null, body: '', author: { login: 'ania' },
  reviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
});

describe('nodeFromPr', () => {
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
    const g = await buildGraph({ repo: 'o/r', number: 1 }, fetchPr, stacked, () => null);
    expect([...g.keys()].sort()).toEqual(['o/r#1', 'o/r#2']);
    expect(fetchPr).toHaveBeenCalledTimes(3);
  });
});
