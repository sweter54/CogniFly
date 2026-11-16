import { afterEach, beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { idZdarzenia, type Zdarzenie } from '@cognifly/wspolne';
import { ustawTabeleTestowa } from './pomocnik.js';
import { klient } from '../../src/dane/tabela.js';
import { zapiszZdarzenie, historia } from '../../src/dane/historia.js';
import { utworzZadanie, wez, ustawStan, oznaczEskalowane, skrzynka, pobierzZadanie } from '../../src/dane/kolejka.js';

const tabela = ustawTabeleTestowa('cognifly-test-awarie');
beforeAll(() => tabela.utworz());
afterAll(() => tabela.usun());
afterEach(() => vi.restoreAllMocks());

const anulowana = (...kody: string[]) =>
  new TransactionCanceledException({
    message: 'x', $metadata: {}, CancellationReasons: kody.map((Code) => ({ Code })),
  });
const nazwaKomendy = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;

/** Podmienia send: pierwsze wywołania TransactWrite rzucają podane błędy, reszta idzie do prawdziwego klienta. */
function wstrzyknij(bledy: unknown[]) {
  const orygin = klient().send.bind(klient()) as (c: unknown) => Promise<unknown>;
  let n = 0;
  const spy = vi.spyOn(klient(), 'send').mockImplementation((async (c: unknown) => {
    if (nazwaKomendy(c) === 'TransactWriteCommand' && n < bledy.length) throw bledy[n++];
    return orygin(c);
  }) as never);
  return { spy, transakcje: () => n };
}

const z: Zdarzenie = {
  id: idZdarzenia('github', 'awarie-1'), firma: 'fa', zrodlo: 'github', typ: 'push',
  czas: '2026-01-01T10:00:00Z', podmiot: {}, opis: 'o', wymagaPracy: false,
};

describe('historia: błędy transakcji', () => {
  test('TransactionConflict jest ponawiany, nie daje DUPLIKAT', async () => {
    const w = wstrzyknij([anulowana('TransactionConflict', 'None')]);
    expect(await zapiszZdarzenie(z)).toBe('NOWE');
    expect(w.transakcje()).toBe(1);
    expect(await zapiszZdarzenie(z)).toBe('DUPLIKAT');
  });
  test('inne anulowanie (np. walidacja) jest rzucane', async () => {
    wstrzyknij([anulowana('ValidationError', 'None')]);
    await expect(zapiszZdarzenie({ ...z, id: idZdarzenia('github', 'awarie-2') })).rejects.toThrow();
  });
  test('uporczywy konflikt po wyczerpaniu prób rzuca', async () => {
    wstrzyknij(Array.from({ length: 10 }, () => anulowana('TransactionConflict', 'None')));
    await expect(zapiszZdarzenie({ ...z, id: idZdarzenia('github', 'awarie-3') })).rejects.toThrow();
  });
});

describe('historia: czas bez milisekund', () => {
  test('wpis bez ms mieści się w zakresie kończącym się tym samym momentem i jest poprawnie uporządkowany', async () => {
    const bezMs = { ...z, id: idZdarzenia('github', 'ms-1'), firma: 'fms', czas: '2026-02-01T10:00:00Z' };
    const zMs = { ...z, id: idZdarzenia('github', 'ms-2'), firma: 'fms', czas: '2026-02-01T10:00:00.500Z' };
    await zapiszZdarzenie(bezMs);
    await zapiszZdarzenie(zMs);
    const t = new Date('2026-02-01T10:00:00Z');
    expect((await historia('fms', new Date(t.getTime() - 1000), t)).map((e) => e.id)).toEqual([bezMs.id]);
    const wszystko = await historia('fms', new Date(t.getTime() - 1000), new Date(t.getTime() + 1000));
    expect(wszystko.map((e) => e.id)).toEqual([zMs.id, bezMs.id]);
  });
});

describe('kolejka: błędy transakcji', () => {
  test('wez: konflikt jest ponawiany i bierze zadanie', async () => {
    const zad = await utworzZadanie('fa', 'evt_1', ['ania']);
    wstrzyknij([anulowana('TransactionConflict', 'None')]);
    expect(await wez('fa', zad.id, 'ania')).toMatchObject({ ok: true });
  });
  test('wez: ConditionalCheckFailed bez właściciela nie daje ZAJETE z pustym właścicielem', async () => {
    const zad = await utworzZadanie('fa', 'evt_1', ['ania']);
    wstrzyknij([anulowana('ConditionalCheckFailed', 'None')]); // zadanie nadal wolne -> ponowna próba
    expect(await wez('fa', zad.id, 'ania')).toMatchObject({ ok: true });
  });
  test('wez: uporczywy CCF bez właściciela rzuca zamiast zwracać ZAJETE', async () => {
    const zad = await utworzZadanie('fa', 'evt_1', ['ania']);
    wstrzyknij(Array.from({ length: 5 }, () => anulowana('ConditionalCheckFailed', 'None')));
    await expect(wez('fa', zad.id, 'ania')).rejects.toThrow();
  });
  test('wez: inny błąd transakcji jest rzucany', async () => {
    const zad = await utworzZadanie('fa', 'evt_1', ['ania']);
    wstrzyknij([anulowana('ThrottlingError', 'None')]);
    await expect(wez('fa', zad.id, 'ania')).rejects.toThrow();
  });
  test('ustawStan / oznaczEskalowane: przejściowy błąd rzuca (nie false); konflikt ponawiany', async () => {
    const zad = await utworzZadanie('fa', 'evt_1', ['ania']);
    wstrzyknij([anulowana('ThrottlingError', 'None')]);
    await expect(oznaczEskalowane('fa', zad.id)).rejects.toThrow();
    vi.restoreAllMocks();
    wstrzyknij([anulowana('TransactionConflict', 'None')]);
    expect(await oznaczEskalowane('fa', zad.id)).toBe(true);
    vi.restoreAllMocks();
    await wez('fa', zad.id, 'ania');
    wstrzyknij([anulowana('ProvisionedThroughputExceeded', 'None')]);
    await expect(ustawStan('fa', zad.id, 'ania', 'zrobione')).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await pobierzZadanie('fa', zad.id))!.stan).toBe('wziete');
  });
});

describe('skrzynka: UnprocessedKeys', () => {
  test('ponawia nieprzetworzone klucze, nic nie gubi', async () => {
    const a = await utworzZadanie('fu', 'evt_1', ['ania']);
    const b = await utworzZadanie('fu', 'evt_1', ['ania']);
    const orygin = klient().send.bind(klient()) as (c: unknown) => Promise<{ Responses?: Record<string, unknown[]>; UnprocessedKeys?: unknown }>;
    let n = 0;
    vi.spyOn(klient(), 'send').mockImplementation((async (c: unknown) => {
      if (nazwaKomendy(c) === 'BatchGetCommand' && n++ === 0) {
        const T = Object.keys((c as { input: { RequestItems: object } }).input.RequestItems)[0]!;
        const keys = (c as { input: { RequestItems: Record<string, { Keys: unknown[] }> } }).input.RequestItems[T]!.Keys;
        // zwróć tylko pierwszy klucz, drugi jako nieprzetworzony
        const pierwszy = await orygin(new (c as { constructor: new (i: unknown) => unknown }).constructor({
          RequestItems: { [T]: { Keys: [keys[0]], ConsistentRead: true } },
        }));
        return { ...pierwszy, UnprocessedKeys: { [T]: { Keys: [keys[1]], ConsistentRead: true } } };
      }
      return orygin(c);
    }) as never);
    const ids = (await skrzynka('fu', 'ania')).map((x) => x.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});
