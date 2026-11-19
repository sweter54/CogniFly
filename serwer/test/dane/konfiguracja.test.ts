import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { Regula } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from './pomocnik.js';
import {
  regulyFirmy, roleFirmy, kontaktOsoby, zapiszRegule, zapiszRole, zapiszKontakt, zapiszOsobe, zapiszTozsamosc, subOsoby, adminiFirmy, rejestrOsob,
  applyMember, removeMember, activeSubs, personIdFor, osobyFirmy, tozsamosc,
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

describe('person registry as copy of Identity', () => {
  const T1 = '2026-01-01T00:00:00Z', T2 = '2026-01-02T00:00:00Z', T3 = '2026-01-03T00:00:00Z';

  test('applyMember_new_person_gets_id_from_email', async () => {
    const f = 'am-new';
    expect(await applyMember(f, { sub: 's-am-new', email: 'Jan.Kowalski@x.pl', role: 'member' }, T1)).toBe('added');
    expect(await rejestrOsob(f)).toEqual([{ osoba: 'jan-kowalski', email: 'Jan.Kowalski@x.pl', rola: 'czlonek', sub: 's-am-new' }]);
    expect(await tozsamosc('s-am-new')).toEqual({ [f]: 'jan-kowalski' });
    expect(await kontaktOsoby(f, 'jan-kowalski')).toEqual({ email: 'Jan.Kowalski@x.pl' });
  });
  test('applyMember_matches_existing_person_by_email_case_insensitive', async () => {
    const f = 'am-email';
    await zapiszOsobe(f, 'michal', { email: 'michal@x.pl', rola: 'admin', sub: 'stary' });
    await zapiszTozsamosc('stary', f, 'michal');
    await zapiszKontakt(f, 'michal', { email: 'michal@x.pl', discordWebhookRef: 'ref' });
    expect(await applyMember(f, { sub: 'nowy', email: 'Michal@X.pl', role: 'admin' }, T1)).toBe('updated');
    expect(await subOsoby(f, 'michal')).toBe('nowy');
    expect(await tozsamosc('nowy')).toEqual({ [f]: 'michal' });
    expect(await tozsamosc('stary')).toEqual({});
    expect((await kontaktOsoby(f, 'michal')).discordWebhookRef).toBe('ref');
  });
  test('applyMember_changes_role_by_sub', async () => {
    const f = 'am-role';
    await applyMember(f, { sub: 's-am-role', email: 'a@x.pl', role: 'member' }, T1);
    expect(await adminiFirmy(f)).toEqual([]);
    expect(await applyMember(f, { sub: 's-am-role', role: 'admin' }, T2)).toBe('updated');
    expect(await adminiFirmy(f)).toEqual(['a']);
    expect((await rejestrOsob(f))[0]?.email).toBe('a@x.pl');
  });
  test('applyMember_without_email_for_unknown_sub_is_skipped', async () => {
    expect(await applyMember('am-noemail', { sub: 'zz', role: 'admin' }, T1)).toBe('skipped');
    expect(await rejestrOsob('am-noemail')).toEqual([]);
    expect(await tozsamosc('zz')).toBeNull();
  });
  test('late_added_after_removed_is_skipped', async () => {
    const f = 'am-late';
    await applyMember(f, { sub: 's-am-late', email: 'a@x.pl', role: 'member' }, T1);
    expect(await removeMember(f, 's-am-late', T3)).toBe('removed');
    expect(await applyMember(f, { sub: 's-am-late', email: 'a@x.pl', role: 'member' }, T2)).toBe('skipped');
    expect(await rejestrOsob(f)).toEqual([]);
    expect(await tozsamosc('s-am-late')).toEqual({});
  });
  test('removeMember_hides_person_and_revokes_profile', async () => {
    const f = 'am-rm';
    await applyMember(f, { sub: 's-am-rm', email: 'a@x.pl', role: 'admin' }, T1);
    expect(await removeMember(f, 's-am-rm', T2)).toBe('removed');
    expect(await osobyFirmy(f)).toEqual([]);
    expect(await adminiFirmy(f)).toEqual([]);
    expect(await rejestrOsob(f)).toEqual([]);
    expect(await activeSubs(f)).toEqual([]);
    expect(await removeMember(f, 'nieznany', T2)).toBe('skipped');
    expect(await removeMember(f, 's-am-rm', T1)).toBe('skipped');
    expect(await applyMember(f, { sub: 's-am-rm', email: 'a@x.pl', role: 'admin' }, T3)).toBe('updated');
    expect(await activeSubs(f)).toEqual(['s-am-rm']);
    expect(await tozsamosc('s-am-rm')).toEqual({ [f]: 'a' });
  });
  test('personIdFor_rules', () => {
    expect(personIdFor('a.b+c@x', new Set())).toBe('a-b-c');
    expect(personIdFor('--@x', new Set())).toBe('osoba');
    expect(personIdFor('jan@x', new Set(['jan']))).toBe('jan-2');
    expect(personIdFor('jan@x', new Set(['jan', 'jan-2']))).toBe('jan-3');
    expect(personIdFor(`${'a'.repeat(60)}@x`, new Set())).toBe('a'.repeat(40));
  });
});
