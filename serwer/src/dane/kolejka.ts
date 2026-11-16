import { randomBytes } from 'node:crypto';
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { klient, nazwaTabeli } from './tabela.js';

export type StanZadania = 'nowe' | 'wziete' | 'w_trakcie' | 'do_akceptacji' | 'zrobione' | 'eskalowane';
export type KanalEskalacji = 'email' | 'discord' | 'claude';
export interface Eskalacja { osoba: string; kanaly: KanalEskalacji[] }

export interface Zadanie {
  id: string;
  firma: string;
  zdarzenieId: string;
  kandydaci: string[];
  wlasciciel?: string;
  stan: StanZadania;
  utworzono: string;
  postep?: string;
  opis: string;
  eskalujDo?: Eskalacja[];
}

export type WynikWez =
  | { ok: true; zadanie: Zadanie }
  | { ok: false; kod: 'ZAJETE'; wlasciciel: string }
  | { ok: false; kod: 'BRAK_DOSTEPU' | 'NIE_ZNALEZIONO' };

/*
 * Schemat rekordów:
 *  zadanie:  pk=FIRMA#<f>#ZAD,            sk=<id>          (źródło prawdy o stanie)
 *  skrzynka: pk=FIRMA#<f>#SKR#<osoba>,    sk=<id>, gsi1pk=OSOBA#<f>#<osoba>, gsi1sk=<stan>#<utworzono>
 * Każda zmiana stanu zadania aktualizuje gsi1sk wszystkich wpisów skrzynki w TEJ SAMEJ transakcji,
 * więc indeks jest zawsze spójny ze stanem zadania. `skrzynka()` i tak zwraca stan z rekordu zadania.
 */
const pkZad = (f: string) => `FIRMA#${f}#ZAD`;
const pkSkr = (f: string, o: string) => `FIRMA#${f}#SKR#${o}`;
const gsiPk = (f: string, o: string) => `OSOBA#${f}#${o}`;

const zRekordu = (it: Record<string, unknown>): Zadanie => {
  const { pk: _pk, sk: _sk, ...reszta } = it;
  return reszta as unknown as Zadanie;
};

export async function utworzZadanie(
  firma: string,
  zdarzenieId: string,
  kandydaci: string[],
  extra?: { opis: string; eskalujDo?: Eskalacja[] },
): Promise<Zadanie> {
  const id = `zad_${randomBytes(6).toString('hex')}`;
  const utworzono = new Date().toISOString();
  const zadanie: Zadanie = {
    id, firma, zdarzenieId, kandydaci, stan: 'nowe', utworzono,
    opis: extra?.opis ?? '',
    ...(extra?.eskalujDo ? { eskalujDo: extra.eskalujDo } : {}),
  };
  const T = nazwaTabeli();
  const items = [
    { Put: { TableName: T, Item: { pk: pkZad(firma), sk: id, ...zadanie }, ConditionExpression: 'attribute_not_exists(sk)' } },
    ...kandydaci.map((o) => ({
      Put: { TableName: T, Item: { pk: pkSkr(firma, o), sk: id, gsi1pk: gsiPk(firma, o), gsi1sk: `nowe#${utworzono}`, zadanieId: id } },
    })),
  ];
  // limit transakcji to 100 elementów
  if (items.length > 100) throw new Error('Za wielu kandydatów (maks. 99)');
  await klient().send(new TransactWriteCommand({ TransactItems: items }));
  return zadanie;
}

export async function pobierzZadanie(firma: string, id: string): Promise<Zadanie | null> {
  const r = await klient().send(
    new GetCommand({ TableName: nazwaTabeli(), Key: { pk: pkZad(firma), sk: id }, ConsistentRead: true }),
  );
  return r.Item ? zRekordu(r.Item) : null;
}

/** Warunkowa zmiana zadania + synchronizacja wpisów skrzynki w jednej transakcji. false = warunek niespełniony. */
async function zmien(
  z: Zadanie,
  nowyStan: StanZadania,
  warunek: string,
  nazwy: Record<string, string>,
  wartosci: Record<string, unknown>,
  ustaw: string,
  ustawWartosci: Record<string, unknown>,
): Promise<boolean> {
  const T = nazwaTabeli();
  try {
    await klient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: T,
              Key: { pk: pkZad(z.firma), sk: z.id },
              ConditionExpression: warunek,
              UpdateExpression: `SET ${ustaw}`,
              ExpressionAttributeNames: nazwy,
              ExpressionAttributeValues: { ...wartosci, ...ustawWartosci },
            },
          },
          ...z.kandydaci.map((o) => ({
            Update: {
              TableName: T,
              Key: { pk: pkSkr(z.firma, o), sk: z.id },
              UpdateExpression: 'SET gsi1sk = :gsk',
              ExpressionAttributeValues: { ':gsk': `${nowyStan}#${z.utworzono}` },
            },
          })),
        ],
      }),
    );
    return true;
  } catch (e) {
    if (e instanceof TransactionCanceledException) return false;
    throw e;
  }
}

export async function wez(firma: string, idZadania: string, osoba: string): Promise<WynikWez> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z) return { ok: false, kod: 'NIE_ZNALEZIONO' };
  if (!z.kandydaci.includes(osoba)) return { ok: false, kod: 'BRAK_DOSTEPU' };
  const ok = await zmien(
    z, 'wziete',
    '#stan = :nowe OR #stan = :eskal',
    { '#stan': 'stan', '#wl': 'wlasciciel' },
    { ':nowe': 'nowe', ':eskal': 'eskalowane' },
    '#stan = :wziete, #wl = :osoba',
    { ':wziete': 'wziete', ':osoba': osoba },
  );
  if (ok) return { ok: true, zadanie: { ...z, stan: 'wziete', wlasciciel: osoba } };
  const aktualne = await pobierzZadanie(firma, idZadania);
  return { ok: false, kod: 'ZAJETE', wlasciciel: aktualne?.wlasciciel ?? '' };
}

export async function ustawStan(
  firma: string, idZadania: string, osoba: string, stan: StanZadania, postep?: string,
): Promise<boolean> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z || z.wlasciciel !== osoba) return false;
  return zmien(
    z, stan,
    '#wl = :osoba',
    { '#wl': 'wlasciciel', '#stan': 'stan', ...(postep !== undefined ? { '#po': 'postep' } : {}) },
    { ':osoba': osoba },
    postep !== undefined ? '#stan = :stan, #po = :po' : '#stan = :stan',
    { ':stan': stan, ...(postep !== undefined ? { ':po': postep } : {}) },
  );
}

/** Tylko z stanu `nowe`. false (bez wyjątku), gdy ktoś już wziął lub zadanie nie istnieje. */
export async function oznaczEskalowane(firma: string, id: string): Promise<boolean> {
  const z = await pobierzZadanie(firma, id);
  if (!z) return false;
  return zmien(z, 'eskalowane', '#stan = :nowe', { '#stan': 'stan' }, { ':nowe': 'nowe' }, '#stan = :esk', { ':esk': 'eskalowane' });
}

export async function skrzynka(firma: string, osoba: string, stany?: StanZadania[]): Promise<Zadanie[]> {
  const T = nazwaTabeli();
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await klient().send(
      new QueryCommand({
        TableName: T, IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': gsiPk(firma, osoba) },
        ExclusiveStartKey: start,
      }),
    );
    for (const it of r.Items ?? []) ids.push(it.zadanieId as string);
    start = r.LastEvaluatedKey;
  } while (start);

  const wynik: Zadanie[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const paczka = ids.slice(i, i + 100);
    const r = await klient().send(
      new BatchGetCommand({
        RequestItems: { [T]: { Keys: paczka.map((id) => ({ pk: pkZad(firma), sk: id })), ConsistentRead: true } },
      }),
    );
    for (const it of r.Responses?.[T] ?? []) wynik.push(zRekordu(it));
  }
  return wynik
    .filter((z) => !stany || stany.includes(z.stan))
    .sort((a, b) => (a.utworzono < b.utworzono ? 1 : -1));
}
