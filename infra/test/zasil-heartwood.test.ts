import { describe, expect, test, vi } from 'vitest';
import {
  planZasilenia, przeczytajOpcje, wykonaj, zasil, type Zaleznosci,
} from '../skrypty/zasil-heartwood.js';

const O = { firma: 'pilot', tematy: ['Dokumenty', 'Oferty'] };
const osoby = [
  { osoba: 'michal', email: 'm@x.pl', rola: 'admin' as const, sub: 'sub-m' },
  { osoba: 'szymon', email: 's@x.pl', rola: 'czlonek' as const },
];

const zbuduj = () => {
  const client = {
    putWork: vi.fn(async () => {}), putOrg: vi.fn(async () => {}), putPerson: vi.fn(async () => {}),
    putWorkspace: vi.fn(async () => {}), putTopic: vi.fn(async () => {}), putGrant: vi.fn(async () => {}),
  };
  const deps = {
    client, osoby: vi.fn(async () => osoby),
    szukajSub: vi.fn(async () => 'sub-s'), zapiszSub: vi.fn(async () => {}),
  } satisfies Zaleznosci;
  return { client, deps };
};

describe('planZasilenia', () => {
  test('kolejność i treść kroków dla admina i członka', () => {
    expect(planZasilenia(osoby, O)).toEqual([
      { typ: 'org', org: 'pilot', nazwa: 'pilot' },
      { typ: 'osoba', org: 'pilot', osoba: 'michal', sub: 'sub-m', isAdmin: true },
      { typ: 'szukajSub', osoba: 'szymon', email: 's@x.pl', rola: 'czlonek' },
      { typ: 'osoba', org: 'pilot', osoba: 'szymon', isAdmin: false },
      { typ: 'przestrzen', org: 'pilot', ws: 'wspolne', nazwa: 'Wspólne' },
      { typ: 'temat', org: 'pilot', ws: 'wspolne', temat: 'Dokumenty' },
      { typ: 'temat', org: 'pilot', ws: 'wspolne', temat: 'Oferty' },
      { typ: 'prawo', org: 'pilot', ws: 'wspolne', osoba: 'michal', right: 'admin' },
      { typ: 'prawo', org: 'pilot', ws: 'wspolne', osoba: 'szymon', right: 'write' },
    ]);
  });
});

describe('opcje', () => {
  test('wymagane flagi i domyślny temat', () => {
    expect(() => przeczytajOpcje([], {})).toThrow(/--firma/);
    expect(() => przeczytajOpcje(['--firma', 'a', '--pula', 'p'], {})).toThrow(/--int-url/);
    const o = przeczytajOpcje(['--firma', 'pilot', '--pula', 'p1', '--int-url', 'https://h'], {});
    expect(o).toMatchObject({ firma: 'pilot', tematy: ['Dokumenty'], wykonaj: false });
    expect(przeczytajOpcje(['--firma', 'a', '--pula', 'p', '--int-url', 'u', '--tematy', 'A,B'], {}).tematy).toEqual(['A', 'B']);
  });
});

describe('zasil / wykonaj na atrapach', () => {
  const opcje = (...a: string[]) => przeczytajOpcje(['--firma', 'pilot', '--pula', 'p1', '--int-url', 'https://h', ...a], {});

  test('na sucho: wypisuje kroki i nie woła klienta ani Cognito', async () => {
    const { client, deps } = zbuduj();
    const linie: string[] = [];
    await zasil(opcje(), (s) => linie.push(s), deps);
    expect(linie.join('\n')).toContain('DRY-RUN');
    expect(linie.join('\n')).toContain('szymon');
    for (const f of Object.values(client)) expect(f).not.toHaveBeenCalled();
    expect(deps.szukajSub).not.toHaveBeenCalled();
    expect(deps.zapiszSub).not.toHaveBeenCalled();
  });

  test('--wykonaj: wywołania klienta w kolejności, sub z Cognito zapisany do rekordu', async () => {
    const { client, deps } = zbuduj();
    await wykonaj(planZasilenia(osoby, O), deps);
    expect(deps.szukajSub).toHaveBeenCalledWith('s@x.pl');
    expect(deps.zapiszSub).toHaveBeenCalledWith('szymon', 's@x.pl', 'czlonek', 'sub-s');
    expect(client.putOrg).toHaveBeenCalledWith('pilot', 'pilot');
    expect(client.putPerson.mock.calls).toEqual([['pilot', 'sub-m', true], ['pilot', 'sub-s', false]]);
    expect(client.putWorkspace).toHaveBeenCalledWith('pilot', 'wspolne', 'Wspólne');
    expect(client.putTopic.mock.calls.map((c: unknown[]) => c[2])).toEqual(['Dokumenty', 'Oferty']);
    expect(client.putGrant.mock.calls).toEqual([
      ['pilot', 'wspolne', 'sub-m', 'admin'], ['pilot', 'wspolne', 'sub-s', 'write'],
    ]);
  });
});
