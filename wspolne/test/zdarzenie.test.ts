import { describe, expect, test } from 'vitest';
import { idZdarzenia, zwalidujZdarzenie } from '../src/zdarzenie.js';

const poprawne = {
  id: idZdarzenia('github', 'delivery-1'),
  firma: 'pilot',
  zrodlo: 'github',
  typ: 'github.push',
  czas: '2026-11-16T10:00:00.000Z',
  podmiot: { repo: 'sweter54/x' },
  opis: 'Nowy commit',
  wymagaPracy: false,
};

describe('zdarzenie', () => {
  test('przyjmuje poprawne zdarzenie', () => {
    const w = zwalidujZdarzenie(poprawne);
    expect(w.ok).toBe(true);
  });
  test('idZdarzenia jest deterministyczne', () => {
    expect(idZdarzenia('github', 'delivery-123')).toBe(idZdarzenia('github', 'delivery-123'));
    expect(idZdarzenia('github', 'a')).not.toBe(idZdarzenia('gitlab', 'a'));
    expect(idZdarzenia('github', 'a')).toMatch(/^evt_[0-9a-f]{24}$/);
  });
  test('odrzuca zdarzenie bez firmy i z nieznanym źródłem', () => {
    expect(zwalidujZdarzenie({ ...poprawne, firma: '' }).ok).toBe(false);
    expect(zwalidujZdarzenie({ ...poprawne, zrodlo: 'slack' }).ok).toBe(false);
  });
  test('opis ograniczony do 300 znaków', () => {
    expect(zwalidujZdarzenie({ ...poprawne, opis: 'x'.repeat(300) }).ok).toBe(true);
    expect(zwalidujZdarzenie({ ...poprawne, opis: 'x'.repeat(301) }).ok).toBe(false);
  });
  test('odrzuca czas nie-ISO i złe id', () => {
    expect(zwalidujZdarzenie({ ...poprawne, czas: 'wczoraj' }).ok).toBe(false);
    expect(zwalidujZdarzenie({ ...poprawne, id: 'x' }).ok).toBe(false);
  });
});
