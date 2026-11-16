import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { Regula } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from './pomocnik.js';
import {
  regulyFirmy, roleFirmy, kontaktOsoby, zapiszRegule, zapiszRole, zapiszKontakt, zapiszOsobe,
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
});
