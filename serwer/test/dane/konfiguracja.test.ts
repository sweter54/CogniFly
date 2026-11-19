import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { Regula } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from './pomocnik.js';
import {
  regulyFirmy, roleFirmy, kontaktOsoby, zapiszRegule, zapiszRole, zapiszKontakt, zapiszOsobe, subOsoby, adminiFirmy, rejestrOsob,
} from '../../src/dane/konfiguracja.js';

const tabela = ustawTabeleTestowa('cognifly-test-konfiguracja');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const reg = (p: Partial<Regula> = {}): Regula => ({
  id: 'r1', firma: 'f1', gdy: { zrodlo: 'github' }, powiadom: { osoby: ['ala'], kanaly: ['discord'] }, ...p,
});

describe('konfiguracja', () => {
  test('reguły: zapis i odczyt per firma', async () => {
    await zapiszRegule(reg({ id: 'a' }));
    await zapiszRegule(reg({ id: 'b', eskalacjaMin: 30 }));
    await zapiszRegule(reg({ id: 'x', firma: 'f2' }));
    const r = await regulyFirmy('f1');
    expect(r.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(r.find((x) => x.id === 'b')?.eskalacjaMin).toBe(30);
    expect(await regulyFirmy('pusta')).toEqual([]);
  });
  test('eskalacjaMin: tylko całkowita 1..10080', async () => {
    for (const v of [0, -1, 1.5, 10081, NaN]) {
      await expect(zapiszRegule(reg({ eskalacjaMin: v }))).rejects.toThrow(/eskalacjaMin/);
    }
    await zapiszRegule(reg({ id: 'ok1', eskalacjaMin: 1 }));
    await zapiszRegule(reg({ id: 'ok2', eskalacjaMin: 10080 }));
  });
  test('role: zwykły obiekt bez pułapek prototypu', async () => {
    await zapiszRole('f1', 'dev', ['ola', 'ewa']);
    await zapiszRole('f1', 'admin', ['szef']);
    const role = await roleFirmy('f1');
    expect(role).toEqual({ dev: ['ola', 'ewa'], admin: ['szef'] });
    expect(Object.hasOwn(role, 'constructor')).toBe(false);
    expect(await roleFirmy('pusta')).toEqual({});
  });
  test('kontakt: zapis, odczyt, brak = {}', async () => {
    await zapiszKontakt('f1', 'ola', { email: 'ola@x.pl', discordWebhookRef: 'sekret/ola' });
    expect(await kontaktOsoby('f1', 'ola')).toEqual({ email: 'ola@x.pl', discordWebhookRef: 'sekret/ola' });
    expect(await kontaktOsoby('f1', 'nikt')).toEqual({});
    expect(await kontaktOsoby('f2', 'ola')).toEqual({});
  });
  test('osoba: zapis nie psuje reguł/ról/kontaktów', async () => {
    await zapiszOsobe('f1', 'ola', { email: 'ola@x.pl', rola: 'admin' });
    expect((await regulyFirmy('f1')).length).toBeGreaterThan(0);
    expect(await roleFirmy('f1')).toHaveProperty('dev');
  });
  test('osoba: sub zapisany i odczytany, brak = null', async () => {
    await zapiszOsobe('f1', 'michal', { email: 'm@x.pl', rola: 'admin', sub: 's1' });
    await zapiszOsobe('f1', 'bezsub', { email: 'b@x.pl', rola: 'czlonek' });
    expect(await subOsoby('f1', 'michal')).toBe('s1');
    expect(await subOsoby('f1', 'bezsub')).toBeNull();
    expect(await subOsoby('f1', 'nikt')).toBeNull();
  });
  test('rejestr osób: pełne rekordy firmy, posortowane, sub opcjonalny', async () => {
    await zapiszOsobe('fr', 'zuza', { email: 'z@x.pl', rola: 'czlonek' });
    await zapiszOsobe('fr', 'adam', { email: 'a@x.pl', rola: 'admin', sub: 's9' });
    await zapiszOsobe('fq', 'obcy', { email: 'o@x.pl', rola: 'admin' });
    expect(await rejestrOsob('fr')).toEqual([
      { osoba: 'adam', email: 'a@x.pl', rola: 'admin', sub: 's9' },
      { osoba: 'zuza', email: 'z@x.pl', rola: 'czlonek' },
    ]);
  });
  test('admini: tylko osoby z rolą admin, posortowane', async () => {
    await zapiszOsobe('fa', 'zuza', { email: 'z@x.pl', rola: 'admin' });
    await zapiszOsobe('fa', 'adam', { email: 'a@x.pl', rola: 'admin', sub: 's2' });
    await zapiszOsobe('fa', 'ewa', { email: 'e@x.pl', rola: 'czlonek' });
    await zapiszOsobe('fb', 'obcy', { email: 'o@x.pl', rola: 'admin' });
    expect(await adminiFirmy('fa')).toEqual(['adam', 'zuza']);
    expect(await adminiFirmy('pusta')).toEqual([]);
  });
});
