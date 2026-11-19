import { describe, expect, test, vi } from 'vitest';
import type { Task } from '@cognifly/wspolne/api';
import {
  opisz, planZasilenia, przeczytajOpcje, wykonaj, zasil, type Zaleznosci,
} from '../skrypty/zasil-heartwood.js';

const O = { firma: 'pilot', tematy: ['Dokumenty', 'Oferty'] };
const temat = (t: string) => ({ typ: 'temat', org: 'pilot', ws: 'wspolne', temat: t });
const osoby = [
  { osoba: 'michal', email: 'm@x.pl', rola: 'admin' as const, sub: 'sub-m' },
  { osoba: 'szymon', email: 's@x.pl', rola: 'czlonek' as const },
];
const zad = (p: Partial<Task>): Task => ({
  id: 'zad_000000000001', stan: 'w_trakcie', wlasciciel: 'michal', ...p,
} as Task);
const zadania = [
  zad({ id: 'zad_000000000001', stan: 'w_trakcie', wlasciciel: 'michal' }),
  zad({ id: 'zad_000000000002', stan: 'do_akceptacji', wlasciciel: 'szymon', akceptujacy: 'michal' }),
];

const zbuduj = () => {
  const client = {
    putWork: vi.fn(async () => {}), putWorkspace: vi.fn(async () => {}),
    putTopic: vi.fn(async () => {}), putGrant: vi.fn(async () => {}),
  };
  const deps = {
    client, osoby: vi.fn(async () => osoby), zadania: vi.fn(async () => zadania),
  } satisfies Zaleznosci;
  return { client, deps };
};

describe('planZasilenia', () => {
  test('plan_has_no_org_or_person_steps', () => {
    const typy = planZasilenia(osoby, zadania, O).map((k) => k.typ);
    expect(typy).not.toContain('org');
    expect(typy).not.toContain('osoba');
    expect(typy).not.toContain('szukajSub');
    expect(typy).toEqual(['przestrzen', 'temat', 'temat', 'temat', 'prawo', 'pominieta', 'praca', 'praca']);
  });

  test('person_without_sub_is_skipped_with_warning', async () => {
    const plan = planZasilenia(osoby, [], O);
    expect(plan.filter((k) => k.typ === 'pominieta')).toEqual([{ typ: 'pominieta', osoba: 'szymon' }]);
    const { client, deps } = zbuduj();
    const linie: string[] = [];
    await wykonaj(plan, deps, (s) => linie.push(s));
    expect(client.putGrant.mock.calls).toEqual([['pilot', 'wspolne', 'sub-m', 'admin']]);
    expect(client.putTopic).toHaveBeenCalledTimes(3);
    expect(linie.join('\n')).toContain('Pominięto szymon: brak sub z Tożsamości');
  });

  test('open_tasks_become_work_with_new_sub', async () => {
    const { client, deps } = zbuduj();
    await wykonaj(planZasilenia(osoby, zadania, O), deps);
    expect(client.putWork.mock.calls).toEqual([
      ['pilot', 'cognifly:zad_000000000001', { writer: 'sub-m', closed: false }],
      ['pilot', 'cognifly:zad_000000000002', { writer: 'sub-m', closed: false }],
    ]);
  });

  test('work of a person without sub or unknown person gets writer null', () => {
    const z = [zad({ wlasciciel: 'szymon' }), zad({ id: 'zad_000000000003', wlasciciel: 'obcy' })];
    const prace = planZasilenia(osoby, z, O).filter((k) => k.typ === 'praca');
    expect(prace.map((k) => k.typ === 'praca' && k.writer)).toEqual([null, null]);
  });

  test('closed and new tasks produce no work step', () => {
    const z = [zad({ stan: 'zrobione' }), zad({ stan: 'nowe' })];
    expect(planZasilenia(osoby, z, O).some((k) => k.typ === 'praca')).toBe(false);
  });

  test('opisz covers praca and pominieta', () => {
    expect(opisz({ typ: 'pominieta', osoba: 'a' })).toMatch(/Pominięto a/);
    expect(opisz({ typ: 'praca', org: 'p', workId: 'cognifly:x', writer: null, closed: false })).toMatch(/cognifly:x/);
  });
});

describe('temat Zadania', () => {
  const tematy = (t: string[]) =>
    planZasilenia(osoby, [], { firma: 'pilot', tematy: t }).filter((k) => k.typ === 'temat');
  test('is always added after the requested topics, without duplicates', () => {
    expect(tematy(['Oferty'])).toEqual([temat('Oferty'), temat('Zadania')]);
    expect(tematy(['Zadania', 'Oferty'])).toEqual([temat('Zadania'), temat('Oferty')]);
  });
});

describe('opcje', () => {
  test('options_need_no_pool', () => {
    expect(() => przeczytajOpcje([], {})).toThrow(/--firma/);
    expect(() => przeczytajOpcje(['--firma', 'a'], {})).toThrow(/--int-url/);
    const o = przeczytajOpcje(['--firma', 'pilot', '--int-url', 'https://h'], {});
    expect(o).toMatchObject({ firma: 'pilot', tematy: ['Dokumenty'], wykonaj: false });
    expect(przeczytajOpcje(['--firma', 'a', '--int-url', 'u', '--tematy', 'A,B'], {}).tematy).toEqual(['A', 'B']);
  });
});

describe('zasil', () => {
  test('na sucho: wypisuje kroki i nie woła klienta', async () => {
    const { client, deps } = zbuduj();
    const linie: string[] = [];
    await zasil(przeczytajOpcje(['--firma', 'pilot', '--int-url', 'https://h'], {}), (s) => linie.push(s), deps);
    expect(linie.join('\n')).toContain('DRY-RUN');
    expect(linie.join('\n')).toContain('szymon');
    for (const f of Object.values(client)) expect(f).not.toHaveBeenCalled();
  });
});
