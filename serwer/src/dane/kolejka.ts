import { randomBytes } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Kanal } from '@cognifly/wspolne';
import { klient, nazwaTabeli, pauza, transakcja } from './tabela.js';
import type { Escalation, Task, TaskState } from '@cognifly/wspolne/api';

// Kontrakt API żyje w @cognifly/wspolne/api (współdzielony z aplikacją).
export type StanZadania = TaskState;
export type KanalEskalacji = Kanal;
export type Eskalacja = Escalation;
export type Zadanie = Task;

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
  extra?: { opis: string; eskalujDo?: Eskalacja[]; id?: string },
): Promise<Zadanie> {
  // `id` podane przez wołającego = tworzenie idempotentne: istniejące zadanie o tym id jest zwracane bez zmian.
  const id = extra?.id ?? `zad_${randomBytes(6).toString('hex')}`;
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
  try {
    await klient().send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (extra?.id && e instanceof TransactionCanceledException && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
      const istniejace = await pobierzZadanie(firma, id);
      if (istniejace) return istniejace;
    }
    throw e;
  }
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
  const w = await transakcja([
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
  ]);
  return w === 'OK';
}

export async function wez(firma: string, idZadania: string, osoba: string): Promise<WynikWez> {
  for (let proba = 0; proba < 3; proba++) {
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
    if (aktualne?.wlasciciel) return { ok: false, kod: 'ZAJETE', wlasciciel: aktualne.wlasciciel };
    await pauza(20); // warunek nie przeszedł, a właściciela brak — ponów z aktualnym stanem
  }
  throw new Error(`wez: nie udało się rozstrzygnąć zadania ${idZadania}`);
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
    let klucze: Record<string, unknown>[] = paczka.map((id) => ({ pk: pkZad(firma), sk: id }));
    for (let proba = 0; klucze.length; proba++) {
      if (proba >= 5) throw new Error('skrzynka: BatchGet nie przetworzył wszystkich kluczy');
      if (proba) await pauza(20 * 2 ** proba);
      const r = await klient().send(
        new BatchGetCommand({ RequestItems: { [T]: { Keys: klucze, ConsistentRead: true } } }),
      );
      for (const it of r.Responses?.[T] ?? []) wynik.push(zRekordu(it));
      klucze = (r.UnprocessedKeys?.[T]?.Keys as Record<string, unknown>[] | undefined) ?? [];
    }
  }
  return wynik
    .filter((z) => !stany || stany.includes(z.stan))
    .sort((a, b) => (a.utworzono < b.utworzono ? 1 : -1));
}
