import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import { loadSeen, notificationBody, notificationTitle, pickNew, saveSeen, trayTitle, trayTooltip } from '../src/logic/notify.js';
import { memoryStore } from '../src/logic/storage.js';

const t = (n: number, stan: Task['stan'] = 'nowe'): Task => ({
  id: `zad_${String(n).padStart(12, '0')}`, firma: 'pilot', zdarzenieId: 'e', kandydaci: [], stan, utworzono: '', opis: `Zadanie ${n}`,
});

describe('pickNew', () => {
  it('first run records 10 old tasks without notifying', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => t(i));
    const r = pickNew(tasks, null);
    expect(r.fresh).toEqual([]);
    expect(r.seen.size).toBe(10);
  });

  it('notifies a task once across polls', () => {
    const first = pickNew([t(1)], new Set());
    expect(first.fresh.map((x) => x.id)).toEqual([t(1).id]);
    expect(pickNew([t(1)], first.seen).fresh).toEqual([]);
  });

  it('notifies again when the same task escalates', () => {
    const { seen } = pickNew([t(1)], new Set());
    const r = pickNew([t(1, 'eskalowane')], seen);
    expect(r.fresh).toHaveLength(1);
    expect(notificationTitle(r.fresh[0]!)).toBe('CogniFly — eskalacja');
  });

  it('ignores tasks that are taken or done and forgets them', () => {
    const r = pickNew([t(1, 'wziete'), t(2, 'zrobione')], new Set([`${t(1).id}#nowe`]));
    expect(r.fresh).toEqual([]);
    expect(r.seen.size).toBe(0);
  });
});

describe('returned tasks', () => {
  it('a task rejected back to me notifies once and counts as waiting', async () => {
    const { pickNew, notificationTitle, waitingTasks } = await import('../src/logic/notify.js');
    const back = { id: 'zad_000000000001', firma: 'f', zdarzenieId: 'e', kandydaci: ['m'], stan: 'odrzucone' as const, utworzono: '', opis: 'X' };
    const first = pickNew([back], new Set());
    expect(first.fresh).toHaveLength(1);
    expect(pickNew([back], first.seen).fresh).toHaveLength(0);
    expect(waitingTasks([back])).toHaveLength(1);
    expect(notificationTitle(back)).toBe('CogniFly — zadanie odrzucone');
    expect(waitingTasks([{ ...back, stan: 'usuniete' }])).toHaveLength(0);
  });
});

describe('acceptance', () => {
  const base = { id: 'zad_000000000002', firma: 'f', zdarzenieId: 'e', kandydaci: ['ania', 'bartek'], utworzono: '', opis: 'Zrób X', wlasciciel: 'ania' };
  it('a task waiting for my acceptance notifies me, not the owner', async () => {
    const { pickNew, notificationTitle, waitingTasks } = await import('../src/logic/notify.js');
    const t = { ...base, stan: 'do_akceptacji' as const, akceptujacy: 'bartek' };
    expect(waitingTasks([t], 'bartek')).toHaveLength(1);
    expect(waitingTasks([t], 'ania')).toHaveLength(0);
    expect(pickNew([t], new Set(), 'bartek').fresh).toHaveLength(1);
    expect(notificationTitle(t)).toBe('CogniFly — do akceptacji');
  });
  it('a task sent back for fixes notifies its owner', async () => {
    const { pickNew, notificationTitle, waitingTasks } = await import('../src/logic/notify.js');
    const t = { ...base, stan: 'w_trakcie' as const, uwagi: { osoba: 'bartek', powod: 'Brak testów' } };
    expect(waitingTasks([t], 'ania')).toHaveLength(1);
    expect(waitingTasks([t], 'bartek')).toHaveLength(0);
    expect(pickNew([t], new Set(), 'ania').fresh).toHaveLength(1);
    expect(notificationTitle(t)).toBe('CogniFly — do poprawy');
  });
});

describe('repeated acceptance rounds', () => {
  it('a new round of fixes or a new submission notifies again', async () => {
    const { pickNew } = await import('../src/logic/notify.js');
    const base = { id: 'zad_000000000003', firma: 'f', zdarzenieId: 'e', kandydaci: ['ania', 'bartek'], utworzono: '', opis: 'X', wlasciciel: 'ania' };
    const fix1 = { ...base, stan: 'w_trakcie' as const, uwagi: { osoba: 'bartek', powod: 'a', czas: '2026-11-18T10:00:00Z' } };
    const fix2 = { ...fix1, uwagi: { ...fix1.uwagi, czas: '2026-11-18T11:00:00Z' } };
    const seen = pickNew([fix1], new Set(), 'ania').seen;
    expect(pickNew([fix2], seen, 'ania').fresh).toHaveLength(1);
    const sub1 = { ...base, stan: 'do_akceptacji' as const, akceptujacy: 'bartek', oddano: '2026-11-18T10:00:00Z' };
    const seenB = pickNew([sub1], new Set(), 'bartek').seen;
    expect(pickNew([{ ...sub1, oddano: '2026-11-18T12:00:00Z' }], seenB, 'bartek').fresh).toHaveLength(1);
    expect(pickNew([sub1], seenB, 'bartek').fresh).toHaveLength(0);
  });
});

describe('notificationBody', () => {
  it('collapses line breaks and control characters into one line', () => {
    expect(notificationBody('Review\nPR #1 \u0007 teraz')).toBe('Review PR #1 teraz');
  });

  it('cuts long text to 200 characters with an ellipsis', () => {
    const body = notificationBody('ż'.repeat(500));
    expect(Array.from(body)).toHaveLength(200);
    expect(body.endsWith('…')).toBe(true);
  });

  it('falls back to a generic text', () => {
    expect(notificationBody(' \n ')).toBe('Masz nowe zadanie.');
  });
});

describe('trayTitle', () => {
  it.each([
    [{ loggedIn: false, offline: false, waiting: 3, conflicts: 1, unsent: 1 }, ''],
    [{ loggedIn: true, offline: false, waiting: 0, conflicts: 0, unsent: 0 }, ''],
    [{ loggedIn: true, offline: true, waiting: 0, conflicts: 0, unsent: 0 }, '!'],
    [{ loggedIn: true, offline: true, waiting: 2, conflicts: 0, unsent: 0 }, '2'],
    [{ loggedIn: true, offline: false, waiting: 150, conflicts: 0, unsent: 0 }, '99+'],
    [{ loggedIn: true, offline: false, waiting: 3, conflicts: 2, unsent: 5 }, '3 ⚠2 ↑5'],
    [{ loggedIn: true, offline: false, waiting: 0, conflicts: 1, unsent: 0 }, '⚠1'],
    [{ loggedIn: true, offline: false, waiting: 0, conflicts: 0, unsent: 4 }, '↑4'],
    [{ loggedIn: true, offline: true, waiting: 0, conflicts: 0, unsent: 4 }, '! ↑4'],
  ])('%j → %s', (state, title) => expect(trayTitle(state)).toBe(title));
});

describe('trayTooltip', () => {
  const base = { loggedIn: true, offline: false, waiting: 0, conflicts: 0, unsent: 0 };
  it.each([
    [{ ...base, loggedIn: false, waiting: 3 }, 'CogniFly: niezalogowano'],
    [base, 'CogniFly: wszystko załatwione'],
    [{ ...base, offline: true }, 'CogniFly: brak połączenia z serwerem'],
    [{ ...base, waiting: 3, conflicts: 1, unsent: 2 }, 'CogniFly: 3 zadania czekają · 1 konflikt pliku · 2 pliki do wysłania'],
    [{ ...base, waiting: 1, conflicts: 2, unsent: 1 }, 'CogniFly: 1 zadanie czeka · 2 konflikty plików · 1 plik do wysłania'],
    [{ ...base, waiting: 5, conflicts: 5, unsent: 12 }, 'CogniFly: 5 zadań czeka · 5 konfliktów plików · 12 plików do wysłania'],
    [{ ...base, offline: true, waiting: 22 }, 'CogniFly: brak połączenia z serwerem · 22 zadania czekają'],
    [{ ...base, blocked: 'Brak dostępu do CogniFly: firma jest zawieszona.', waiting: 1 }, 'CogniFly: Brak dostępu do CogniFly: firma jest zawieszona. · 1 zadanie czeka'],
  ])('%j → %s', (state, text) => expect(trayTooltip(state)).toBe(text));
});

describe('seen persistence', () => {
  it('returns null before the first save and the set afterwards', () => {
    const store = memoryStore();
    expect(loadSeen(store)).toBeNull();
    saveSeen(store, new Set(['a#nowe']));
    expect(loadSeen(store)).toEqual(new Set(['a#nowe']));
  });
});
