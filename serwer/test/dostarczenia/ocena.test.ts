import { describe, expect, test } from 'vitest';
import { parseDependsOn, refKey, stackedOn, type PrRef } from '../../src/dostarczenia/zaleznosci.js';
import { assessChain, type ChainNode } from '../../src/dostarczenia/ocena.js';

const ref = (repo: string, number: number): PrRef => ({ repo, number });

describe('parseDependsOn', () => {
  test('reads #n and owner/repo#n from "Zależy od:" / "Depends on:" lines, dedupes and skips itself', () => {
    const body = 'Opis\nZależy od: #12, org/inne#34\nzalezy od: #12\nDepends on: Org/Inne#34 i #5\nnie: #99';
    expect(parseDependsOn(body, ref('o/r', 7))).toEqual([ref('o/r', 12), ref('org/inne', 34), ref('o/r', 5)]);
    expect(parseDependsOn('Zależy od: #7', ref('o/r', 7))).toEqual([]);
    expect(parseDependsOn(null, ref('o/r', 7))).toEqual([]);
  });
  test('ignores malformed references', () => {
    expect(parseDependsOn('Zależy od: #0, x/#3, ../a#4, #abc', ref('o/r', 1))).toEqual([]);
  });
});

describe('stackedOn', () => {
  test('finds the open PR whose head branch is this PR base branch (same repo)', () => {
    const open = [{ number: 3, headRef: 'feat-a' }, { number: 4, headRef: 'feat-b' }];
    expect(stackedOn('o/r', 'feat-b', open)).toEqual(ref('o/r', 4));
    expect(stackedOn('o/r', 'main', open)).toBeNull();
  });
});

/** Ready-to-deliver node; tests override fields. */
const node = (r: PrRef, over: Partial<ChainNode> = {}): ChainNode => ({
  ref: r, open: true, merged: false, headSha: 'h1', mergeable: true, ci: 'success',
  reviewDecision: null, changesRequestedAfterAcceptance: false, acceptedSha: 'h1', deps: [], ...over,
});

describe('assessChain', () => {
  const A = ref('o/r', 1), B = ref('o/r', 2), C = ref('x/y', 3);

  test('ready when accepted on head, CI green, no conflicts and deps merged', () => {
    const g = new Map([[refKey(A), node(A, { deps: [B] })], [refKey(B), node(B, { open: false, merged: true })]]);
    expect(assessChain(A, g)).toEqual({ ready: true, reasons: [], order: [A] });
  });

  test('waits for unmerged dependency and orders the chain dependency-first', () => {
    const g = new Map([[refKey(A), node(A, { deps: [B] })], [refKey(B), node(B, { deps: [C] })], [refKey(C), node(C)]]);
    const r = assessChain(A, g);
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual([`CZEKA_NA ${refKey(B)}`]);
    expect(r.order).toEqual([C, B, A]);
  });

  test('cycle A→B→A is reported and never ready', () => {
    const g = new Map([[refKey(A), node(A, { deps: [B] })], [refKey(B), node(B, { deps: [A] })]]);
    expect(assessChain(A, g)).toMatchObject({ ready: false, reasons: ['CYKL'] });
  });

  test('new commit after acceptance, later change request, conflicts and CI are reasons', () => {
    expect(assessChain(A, new Map([[refKey(A), node(A, { headSha: 'h2' })]])).reasons).toEqual(['NOWY_COMMIT']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { changesRequestedAfterAcceptance: true })]])).reasons).toEqual(['ZMIANY_ZADANE']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { mergeable: false, ci: 'failure' })]])).reasons).toEqual(['KONFLIKT', 'CI_BLAD']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { mergeable: null, ci: 'pending' })]])).reasons).toEqual(['SCALANIE_SPRAWDZANE', 'CI_W_TOKU']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { acceptedSha: null })]])).reasons).toEqual(['NIE_ZAAKCEPTOWANY']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { reviewDecision: 'REVIEW_REQUIRED' })]])).reasons).toEqual(['WYMAGANA_RECENZJA']);
  });

  test('dependency the token cannot read waits and is never treated as merged', () => {
    const g = new Map([[refKey(A), node(A, { deps: [C] })]]);
    expect(assessChain(A, g)).toMatchObject({ ready: false, reasons: [`ZALEZNOSC_NIEDOSTEPNA ${refKey(C)}`] });
  });

  test('closed without merge or already merged root', () => {
    expect(assessChain(A, new Map([[refKey(A), node(A, { open: false })]])).reasons).toEqual(['ZAMKNIETY']);
    expect(assessChain(A, new Map([[refKey(A), node(A, { open: false, merged: true })]])).reasons).toEqual(['SCALONY']);
  });
});
