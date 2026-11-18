import type { Task } from '@cognifly/wspolne/api';
import { describe, expect, it } from 'vitest';
import { canReject, displayOrder, isFinished, rejectionText, selectValue } from '../src/logic/inbox-view.js';

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

describe('rejection rules', () => {
  const sent = (stan: Task['stan'], extra: Partial<Task> = {}): Task => ({ ...t(1, stan), nadawca: 'michal', kandydaci: ['ania'], ...extra });
  it('deleted tasks are finished', () => {
    expect(isFinished(t(1, 'usuniete'))).toBe(true);
    expect(isFinished(t(1, 'odrzucone'))).toBe(false);
  });
  it('a candidate of a waiting task or its owner may reject; never without a sender or for the sender', () => {
    expect(canReject(sent('nowe'), 'ania')).toBe(true);
    expect(canReject(sent('w_trakcie', { wlasciciel: 'ania' }), 'ania')).toBe(true);
    expect(canReject(sent('wziete', { wlasciciel: 'bartek', kandydaci: ['ania', 'bartek'] }), 'ania')).toBe(false);
    expect(canReject({ ...t(1, 'nowe'), kandydaci: ['ania'] }, 'ania')).toBe(false);
    expect(canReject(sent('odrzucone', { wlasciciel: 'michal', kandydaci: ['michal'] }), 'michal')).toBe(false);
    expect(canReject(sent('zrobione', { wlasciciel: 'ania' }), 'ania')).toBe(false);
    expect(canReject(sent('nowe'), null)).toBe(false);
  });
  it('describes who rejected and why, as one line', () => {
    expect(rejectionText(sent('odrzucone', { odrzucenie: { osoba: 'ania', powod: 'Nie\nmój obszar' } })))
      .toBe('Odrzucone przez ania: „Nie mój obszar”');
    expect(rejectionText(t(1, 'nowe'))).toBe('');
    expect(rejectionText(sent('w_trakcie', { odrzucenie: { osoba: 'ania', powod: 'x' } }))).toBe('');
  });
});
