import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { ustawTabeleTestowa } from './pomocnik.js';
import { utworzZadanie, wez, ustawStan, skrzynka, pobierzZadanie, oznaczEskalowane, otwarteZadania, doAkceptacji } from '../../src/dane/kolejka.js';

const tabela = ustawTabeleTestowa('cognifly-test-kolejka');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const zdId = 'evt_000000000000000000000001';

describe('kolejka', () => {
  test('utworzZadanie: id zad_+12 hex, stan nowe, opis/eskalujDo', async () => {
    const eskalujDo = [{ osoba: 'szef', kanaly: ['email' as const] }];
    const zad = await utworzZadanie('f1', zdId, ['ania'], { opis: 'Zrób X', eskalujDo });
    expect(zad.id).toMatch(/^zad_[0-9a-f]{12}$/);
    expect(zad).toMatchObject({ stan: 'nowe', opis: 'Zrób X', eskalujDo, kandydaci: ['ania'] });
    expect((await utworzZadanie('f1', zdId, ['ania'])).opis).toBe('');
  });
  test('dwóch klika „biorę” naraz → wygrywa jeden', async () => {
    const zad = await utworzZadanie('f1', zdId, ['ania', 'bartek']);
    const [a, b] = await Promise.all([wez('f1', zad.id, 'ania'), wez('f1', zad.id, 'bartek')]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const przegrane = [a, b].find((r) => !r.ok)!;
    expect(przegrane).toMatchObject({ ok: false, kod: 'ZAJETE' });
    const wygrana = [a, b].find((r) => r.ok) as Extract<typeof a, { ok: true }>;
    expect((przegrane as { wlasciciel: string }).wlasciciel).toBe(wygrana.zadanie.wlasciciel);
  });
  test('osoba spoza kandydatów nie weźmie zadania; nieistniejące; obca firma', async () => {
    const zad = await utworzZadanie('f1', zdId, ['ania']);
    expect(await wez('f1', zad.id, 'obcy')).toMatchObject({ ok: false, kod: 'BRAK_DOSTEPU' });
    expect(await wez('f1', 'zad_ffffffffffff', 'ania')).toMatchObject({ ok: false, kod: 'NIE_ZNALEZIONO' });
    expect(await wez('inna', zad.id, 'ania')).toMatchObject({ ok: false, kod: 'NIE_ZNALEZIONO' });
  });
  test('zmiana stanu tylko przez właściciela', async () => {
    const zad = await utworzZadanie('f1', zdId, ['ania', 'bartek']);
    expect((await wez('f1', zad.id, 'ania')).ok).toBe(true);
    expect(await ustawStan('f1', zad.id, 'bartek', 'w_trakcie')).toBe(false);
    expect(await ustawStan('f1', zad.id, 'ania', 'w_trakcie', '50%')).toBe(true);
    expect(await pobierzZadanie('f1', zad.id)).toMatchObject({ stan: 'w_trakcie', postep: '50%', wlasciciel: 'ania' });
  });
  test('skrzynka: widoczna u kandydatów, aktualny stan, filtr stanów, izolacja firm', async () => {
    const zad = await utworzZadanie('f3', zdId, ['ania', 'bartek']);
    expect((await skrzynka('f3', 'ania')).map((x) => x.id)).toEqual([zad.id]);
    expect((await skrzynka('f3', 'bartek')).map((x) => x.id)).toEqual([zad.id]);
    expect(await skrzynka('f3', 'obcy')).toEqual([]);
    expect(await skrzynka('inna', 'ania')).toEqual([]);
    await wez('f3', zad.id, 'ania');
    expect((await skrzynka('f3', 'bartek'))[0]).toMatchObject({ stan: 'wziete', wlasciciel: 'ania' });
    expect(await skrzynka('f3', 'bartek', ['nowe'])).toEqual([]);
    expect(await skrzynka('f3', 'bartek', ['wziete'])).toHaveLength(1);
    await ustawStan('f3', zad.id, 'ania', 'zrobione');
    expect(await skrzynka('f3', 'ania', ['zrobione'])).toHaveLength(1);
  });
  test('oznaczEskalowane: tylko z nowe; potem można wziąć', async () => {
    const zad = await utworzZadanie('f4', zdId, ['ania']);
    expect(await oznaczEskalowane('f4', zad.id)).toBe(true);
    expect(await oznaczEskalowane('f4', zad.id)).toBe(false);
    expect((await pobierzZadanie('f4', zad.id))!.stan).toBe('eskalowane');
    expect((await wez('f4', zad.id, 'ania')).ok).toBe(true);
    expect(await oznaczEskalowane('f4', zad.id)).toBe(false);
    expect(await pobierzZadanie('f4', 'zad_ffffffffffff')).toBeNull();
  });
});

describe('otwarteZadania', () => {
  test('otwarteZadania_returns_only_open_states', async () => {
    const nowe = await utworzZadanie('fo', zdId, ['ania']);
    const wziete = await utworzZadanie('fo', zdId, ['ania']);
    const trakcie = await utworzZadanie('fo', zdId, ['ania']);
    const akcept = await utworzZadanie('fo', zdId, ['ania']);
    const zrobione = await utworzZadanie('fo', zdId, ['ania']);
    await utworzZadanie('inna-fo', zdId, ['ania']);
    for (const z of [wziete, trakcie, akcept, zrobione]) await wez('fo', z.id, 'ania');
    await ustawStan('fo', trakcie.id, 'ania', 'w_trakcie');
    await doAkceptacji('fo', akcept.id, 'ania', 'bartek');
    await ustawStan('fo', zrobione.id, 'ania', 'zrobione');
    const ids = (await otwarteZadania('fo')).map((z) => z.id).sort();
    expect(ids).toEqual([wziete.id, trakcie.id, akcept.id].sort());
    expect(ids).not.toContain(nowe.id);
  });
});
