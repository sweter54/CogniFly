import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { idZdarzenia, type Zdarzenie } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from './pomocnik.js';
import { zapiszZdarzenie, historia } from '../../src/dane/historia.js';

const tabela = ustawTabeleTestowa('cognifly-test-historia');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());

const z: Zdarzenie = {
  id: idZdarzenia('github', 'delivery-1'),
  firma: 'f1',
  zrodlo: 'github',
  typ: 'push',
  czas: new Date().toISOString(),
  podmiot: { repo: 'a/b' },
  opis: 'Push na main',
  wymagaPracy: false,
};
const minus = (n: number) => new Date(Date.now() - n * 3600_000);
const plus = (n: number) => new Date(Date.now() + n * 3600_000);

describe('historia', () => {
  test('ten sam webhook dwa razy → jedno zdarzenie', async () => {
    expect(await zapiszZdarzenie(z)).toBe('NOWE');
    expect(await zapiszZdarzenie(z)).toBe('DUPLIKAT');
    expect(await historia(z.firma, minus(1), plus(1))).toHaveLength(1);
  });
  test('historia nie miesza firm', async () => {
    await zapiszZdarzenie({ ...z, id: idZdarzenia('github', 'x'), firma: 'inna' });
    const h = await historia(z.firma, minus(1), plus(1));
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((e) => e.firma === z.firma)).toBe(true);
  });
  test('malejąco po czasie i filtry źródła/typu', async () => {
    const t = Date.now();
    const mk = (k: string, zrodlo: Zdarzenie['zrodlo'], typ: string, dt: number): Zdarzenie => ({
      ...z, id: idZdarzenia(zrodlo, k), firma: 'f2', zrodlo, typ, czas: new Date(t + dt).toISOString(),
    });
    await zapiszZdarzenie(mk('a', 'github', 'push', 1000));
    await zapiszZdarzenie(mk('b', 'gitlab', 'pr', 2000));
    await zapiszZdarzenie(mk('c', 'github', 'pr', 3000));
    const wszystkie = await historia('f2', minus(1), plus(1));
    expect(wszystkie.map((e) => e.czas)).toEqual([...wszystkie.map((e) => e.czas)].sort().reverse());
    expect(wszystkie).toHaveLength(3);
    expect(await historia('f2', minus(1), plus(1), { zrodlo: 'github' })).toHaveLength(2);
    expect(await historia('f2', minus(1), plus(1), { typ: 'pr' })).toHaveLength(2);
    expect(await historia('f2', minus(1), plus(1), { zrodlo: 'github', typ: 'pr' })).toHaveLength(1);
  });
  test('wpis ma TTL (wygasa) ~ retencja', async () => {
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const { klient, nazwaTabeli } = await import('../../src/dane/tabela.js');
    const r = await klient().send(new GetCommand({ TableName: nazwaTabeli(), Key: { pk: 'FIRMA#f1#EVT', sk: z.id } }));
    const dni = ((r.Item!.wygasa as number) * 1000 - Date.now()) / 86400_000;
    expect(dni).toBeGreaterThan(89);
    expect(dni).toBeLessThan(91);
  });
});
