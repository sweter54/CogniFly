import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import { loadSeen, notificationBody, notificationTitle, pickNew, saveSeen, trayTitle } from '../src/logic/notify.js';
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
    [{ loggedIn: false, offline: false, waiting: 3 }, ''],
    [{ loggedIn: true, offline: false, waiting: 0 }, ''],
    [{ loggedIn: true, offline: true, waiting: 0 }, '!'],
    [{ loggedIn: true, offline: true, waiting: 2 }, '2'],
    [{ loggedIn: true, offline: false, waiting: 150 }, '99+'],
  ])('%j → %s', (state, title) => expect(trayTitle(state)).toBe(title));
});

describe('seen persistence', () => {
  it('returns null before the first save and the set afterwards', () => {
    const store = memoryStore();
    expect(loadSeen(store)).toBeNull();
    saveSeen(store, new Set(['a#nowe']));
    expect(loadSeen(store)).toEqual(new Set(['a#nowe']));
  });
});
