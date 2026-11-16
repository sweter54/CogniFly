import { describe, expect, test } from 'vitest';
import { idZdarzenia, type Regula, type Zdarzenie } from '@cognifly/wspolne';
import { rozstrzygnij } from '../../src/reguly/silnik.js';

const zd = (p: Partial<Zdarzenie> = {}): Zdarzenie => ({
  id: idZdarzenia('github', 'x'),
  firma: 'f1',
  zrodlo: 'github',
  typ: 'github.pr.opened',
  czas: '2026-11-16T10:00:00.000Z',
  podmiot: { repo: 'app', numer: 7 },
  opis: 'PR otwarty',
  wymagaPracy: true,
  ...p,
});

const reg = (p: Partial<Regula> = {}): Regula => ({
  id: 'r1',
  firma: 'f1',
  gdy: { zrodlo: 'github' },
  powiadom: { osoby: ['ala'], kanaly: ['discord'] },
  ...p,
});

const PUSTA = { powiadom: [], kandydaci: [], eskalacjaMin: null, eskalujDo: [], auto: false };

describe('rozstrzygnij', () => {
  test('brak pasujących reguł -> pusta decyzja', () => {
    expect(rozstrzygnij(zd(), [], {})).toEqual(PUSTA);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'gitlab' } })], {})).toEqual(PUSTA);
  });

  test('typ dokładny i prefiks z *', () => {
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', typ: 'github.pr.opened' } })], {}).powiadom).toHaveLength(1);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', typ: 'github.pr.*' } })], {}).powiadom).toHaveLength(1);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', typ: 'github.issue.*' } })], {})).toEqual(PUSTA);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', typ: 'github.pr' } })], {})).toEqual(PUSTA);
  });

  test('podmiot musi pasować', () => {
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', podmiot: { repo: 'app' } } })], {}).powiadom).toHaveLength(1);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', podmiot: { repo: 'inne' } } })], {})).toEqual(PUSTA);
    expect(rozstrzygnij(zd(), [reg({ gdy: { zrodlo: 'github', podmiot: { numer: 7 } } })], {}).powiadom).toHaveLength(1);
  });

  test('rola rozwijana na osoby', () => {
    const d = rozstrzygnij(zd(), [reg({ powiadom: { role: ['dev'], kanaly: ['email'] } })], { dev: ['ola', 'ewa'] });
    expect(d.powiadom).toEqual([
      { osoba: 'ola', kanaly: ['email'] },
      { osoba: 'ewa', kanaly: ['email'] },
    ]);
  });

  test('reguła innej firmy ignorowana', () => {
    expect(rozstrzygnij(zd(), [reg({ firma: 'f2' })], {})).toEqual(PUSTA);
  });

  test('domyślna eskalacja 15 min gdy jest przydział; null gdy brak', () => {
    expect(rozstrzygnij(zd(), [reg({ przydziel: { osoby: ['bob'] } })], {}).eskalacjaMin).toBe(15);
    expect(rozstrzygnij(zd(), [reg()], {}).eskalacjaMin).toBeNull();
  });

  test('eskalacjaMin = najmniejsza spośród reguł z przydziałem', () => {
    const d = rozstrzygnij(
      zd(),
      [
        reg({ id: 'a', przydziel: { osoby: ['x'] }, eskalacjaMin: 30 }),
        reg({ id: 'b', przydziel: { osoby: ['y'] }, eskalacjaMin: 5 }),
        reg({ id: 'c', eskalacjaMin: 1 }),
      ],
      {},
    );
    expect(d.eskalacjaMin).toBe(5);
    expect(d.kandydaci).toEqual(['x', 'y']);
  });

  test('dwie reguły -> osoby bez duplikatów, kanały sumowane', () => {
    const d = rozstrzygnij(
      zd(),
      [
        reg({ id: 'a', powiadom: { osoby: ['ala', 'bob'], kanaly: ['discord'] } }),
        reg({ id: 'b', powiadom: { role: ['dev'], kanaly: ['discord', 'email'] } }),
      ],
      { dev: ['ala'] },
    );
    expect(d.powiadom).toEqual([
      { osoba: 'ala', kanaly: ['discord', 'email'] },
      { osoba: 'bob', kanaly: ['discord'] },
    ]);
  });

  test('kandydaci z przydziel (osoby + role) bez duplikatów', () => {
    const d = rozstrzygnij(zd(), [reg({ przydziel: { osoby: ['ola'], role: ['dev'] } })], { dev: ['ola', 'ewa'] });
    expect(d.kandydaci).toEqual(['ola', 'ewa']);
  });

  test('eskalujDo scalane per osoba', () => {
    const d = rozstrzygnij(
      zd(),
      [
        reg({ id: 'a', eskalujDo: { osoby: ['szef'], kanaly: ['email'] } }),
        reg({ id: 'b', eskalujDo: { osoby: ['szef'], kanaly: ['claude'] } }),
      ],
      {},
    );
    expect(d.eskalujDo).toEqual([{ osoba: 'szef', kanaly: ['email', 'claude'] }]);
  });

  test('auto false gdy jedna z reguł z przydziałem nie ma auto', () => {
    const a = reg({ id: 'a', przydziel: { osoby: ['x'] }, auto: true });
    const b = reg({ id: 'b', przydziel: { osoby: ['y'] } });
    expect(rozstrzygnij(zd(), [a, b], {}).auto).toBe(false);
    expect(rozstrzygnij(zd(), [a], {}).auto).toBe(true);
  });

  test('auto ignoruje reguły bez przydziału; brak przydziału -> false', () => {
    const a = reg({ id: 'a', przydziel: { osoby: ['x'] }, auto: true });
    expect(rozstrzygnij(zd(), [a, reg({ id: 'b' })], {}).auto).toBe(true);
    expect(rozstrzygnij(zd(), [reg({ auto: true })], {}).auto).toBe(false);
  });

  test('nieznana rola -> brak osób', () => {
    expect(rozstrzygnij(zd(), [reg({ powiadom: { role: ['nikt'], kanaly: ['email'] } })], {}).powiadom).toEqual([]);
  });
  test('rola o nazwie z prototypu (constructor/__proto__) nie psuje wyniku', () => {
    for (const nazwa of ['constructor', '__proto__', 'toString']) {
      const d = rozstrzygnij(zd(), [reg({ powiadom: { role: [nazwa], kanaly: ['email'] } })], {});
      expect(d.powiadom).toEqual([]);
    }
  });
});
