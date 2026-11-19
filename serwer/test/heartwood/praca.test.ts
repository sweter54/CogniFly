import { describe, expect, it } from 'vitest';
import type { Task } from '@cognifly/wspolne/api';
import { taskIdOf, workIdOf, workStateOf } from '../../src/heartwood/praca.js';

const task = (p: Partial<Task>): Task => ({
  id: 'zad_0123456789ab', firma: 'f', zdarzenieId: 'z', kandydaci: [],
  stan: 'nowe', utworzono: '2026-01-01T00:00:00Z', opis: 'o', ...p,
});

describe('workStateOf', () => {
  it.each([
    [{ stan: 'wziete', wlasciciel: 'os1' }, { writer: 'os1', closed: false }],
    [{ stan: 'w_trakcie', wlasciciel: 'os2' }, { writer: 'os2', closed: false }],
    [{ stan: 'w_trakcie' }, { writer: null, closed: false }],
    [{ stan: 'do_akceptacji', akceptujacy: 'os3', wlasciciel: 'os1' }, { writer: 'os3', closed: false }],
    [{ stan: 'do_akceptacji' }, { writer: null, closed: false }],
    [{ stan: 'zrobione' }, { writer: null, closed: true }],
    [{ stan: 'odrzucone' }, { writer: null, closed: true }],
    [{ stan: 'usuniete' }, { writer: null, closed: true }],
    [{ stan: 'nowe' }, null],
    [{ stan: 'eskalowane' }, null],
  ] as [Partial<Task>, unknown][])('%j', (p, want) => {
    expect(workStateOf(task(p))).toEqual(want);
  });
});

describe('work ids', () => {
  it('prefixes task ids', () => {
    expect(workIdOf('zad_0123456789ab')).toBe('cognifly:zad_0123456789ab');
  });
  it('parses only cognifly task ids', () => {
    expect(taskIdOf('cognifly:zad_0123456789ab')).toBe('zad_0123456789ab');
    expect(taskIdOf('jira:1')).toBeNull();
    expect(taskIdOf('cognifly:xyz')).toBeNull();
  });
});
