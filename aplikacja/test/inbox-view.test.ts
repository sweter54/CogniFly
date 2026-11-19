import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import { displayOrder, isFinished, selectValue } from '../src/logic/inbox-view.js';

const t = (n: number, stan: Task['stan']): Task => ({
  id: `zad_${String(n).padStart(12, '0')}`, firma: 'pilot', zdarzenieId: 'e', kandydaci: [], stan, utworzono: '', opis: `Zadanie ${n}`,
});

describe('displayOrder', () => {
  it('moves finished tasks to the end, keeping server order in groups', () => {
    const tasks = [t(1, 'zrobione'), t(2, 'eskalowane'), t(3, 'zrobione'), t(4, 'w_trakcie')];
    expect(displayOrder(tasks).map((x) => x.id)).toEqual([t(2, 'nowe').id, t(4, 'nowe').id, t(1, 'nowe').id, t(3, 'nowe').id]);
  });

  it('does not change the input array', () => {
    const tasks = [t(1, 'zrobione'), t(2, 'nowe')];
    displayOrder(tasks);
    expect(tasks[0]!.stan).toBe('zrobione');
  });
});

describe('isFinished', () => {
  it('is true only for zrobione', () => {
    expect(isFinished(t(1, 'zrobione'))).toBe(true);
    expect(isFinished(t(1, 'do_akceptacji'))).toBe(false);
  });
});

describe('selectValue', () => {
  it('shows a user-settable state', () => {
    expect(selectValue(t(1, 'zrobione'))).toBe('zrobione');
    expect(selectValue(t(1, 'w_trakcie'))).toBe('w_trakcie');
  });

  it('falls back to the placeholder for other states', () => {
    expect(selectValue(t(1, 'wziete'))).toBe('');
    expect(selectValue(t(1, 'nowe'))).toBe('');
  });
});
