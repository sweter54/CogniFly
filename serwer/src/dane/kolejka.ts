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
  extra?: { opis: string; eskalujDo?: Eskalacja[]; id?: string; nadawca?: string },
): Promise<Zadanie> {
  // `id` podane przez wołającego = tworzenie idempotentne: istniejące zadanie o tym id jest zwracane bez zmian.
  const id = extra?.id ?? `zad_${randomBytes(6).toString('hex')}`;
  const utworzono = new Date().toISOString();
  const zadanie: Zadanie = {
    id, firma, zdarzenieId, kandydaci, stan: 'nowe', utworzono,
    opis: extra?.opis ?? '',
    ...(extra?.eskalujDo ? { eskalujDo: extra.eskalujDo } : {}),
    ...(extra?.nadawca ? { nadawca: extra.nadawca } : {}),
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
      '(#stan = :nowe OR #stan = :eskal) AND contains(#kan, :osoba)',
      { '#stan': 'stan', '#wl': 'wlasciciel', '#kan': 'kandydaci' },
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

/** Stany, z których zwykła zmiana stanu jest niedozwolona (tylko usuń/przekaż albo koniec). */
const ZAMKNIETE_DLA_STANU: readonly string[] = ['odrzucone', 'usuniete'];

export async function ustawStan(
  firma: string, idZadania: string, osoba: string, stan: StanZadania, postep?: string,
): Promise<boolean> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z || z.wlasciciel !== osoba || ZAMKNIETE_DLA_STANU.includes(z.stan)) return false;
  // Inny stan niż do_akceptacji kończy oczekiwanie na akceptującego.
  return zmien(
    z, stan,
    '#wl = :osoba AND #stan <> :odrz AND #stan <> :usun',
    { '#wl': 'wlasciciel', '#stan': 'stan', '#ak': 'akceptujacy', ...(postep !== undefined ? { '#po': 'postep' } : {}) },
    { ':osoba': osoba, ':odrz': 'odrzucone', ':usun': 'usuniete' },
    `${postep !== undefined ? '#stan = :stan, #po = :po' : '#stan = :stan'} REMOVE #ak`,
    { ':stan': stan, ...(postep !== undefined ? { ':po': postep } : {}) },
  );
}

/** Nowy stan zadania przenoszonego do jednej osoby. */
interface Przeniesienie {
  cel: string;
  stan: StanZadania;
  /** Właściciel po przeniesieniu; brak = zadanie czeka na „biorę”. */
  wlasciciel?: string;
  /** Pola ustawiane obok stanu (np. `postep`, `nadawca`, `odrzucenie`). */
  pola: Record<string, unknown>;
  /** Pola usuwane z zadania. */
  usun: string[];
}

/** Warunek zapisu (wyrażenie DynamoDB z nazwami i wartościami). */
interface Warunek { wyr: string; nazwy: Record<string, string>; wartosci: Record<string, unknown> }

/**
 * Przenosi zadanie do jednej osoby w jednej transakcji.
 *
 * Wywołanie: `await przeniesDo(z, p, w)`.
 * Oczekuje: zadanie odczytane przed chwilą; warunek chroniący przed
 * wyścigiem (np. „właścicielem jest wołający”).
 * Wynik: zadanie po zmianie albo null, gdy warunek nie przeszedł.
 * Wpisy skrzynki innych kandydatów znikają, cel dostaje wpis z nowym
 * stanem.
 */
async function przeniesDo(z: Zadanie, p: Przeniesienie, w: Warunek): Promise<Zadanie | null> {
  const T = nazwaTabeli();
  const pola: Record<string, unknown> = { stan: p.stan, kandydaci: [p.cel], ...p.pola, ...(p.wlasciciel ? { wlasciciel: p.wlasciciel } : {}) };
  const usun = [...p.usun, ...(p.wlasciciel ? [] : ['wlasciciel'])];
  const nazwy: Record<string, string> = { ...w.nazwy };
  const wartosci: Record<string, unknown> = { ...w.wartosci };
  const ustaw = Object.entries(pola).map(([k, v], i) => {
    nazwy[`#u${i}`] = k;
    wartosci[`:u${i}`] = v;
    return `#u${i} = :u${i}`;
  });
  const usuwane = usun.map((k, i) => {
    nazwy[`#r${i}`] = k;
    return `#r${i}`;
  });
  if (z.kandydaci.length > 98) throw new Error('Za wielu kandydatów do przeniesienia (maks. 98)'); // limit 100 elementów
  const wynik = await transakcja([
    {
      Update: {
        TableName: T, Key: { pk: pkZad(z.firma), sk: z.id }, ConditionExpression: w.wyr,
        UpdateExpression: `SET ${ustaw.join(', ')}${usuwane.length ? ` REMOVE ${usuwane.join(', ')}` : ''}`,
        ExpressionAttributeNames: nazwy, ExpressionAttributeValues: wartosci,
      },
    },
    ...z.kandydaci.filter((o) => o !== p.cel).map((o) => ({ Delete: { TableName: T, Key: { pk: pkSkr(z.firma, o), sk: z.id } } })),
    {
      Put: {
        TableName: T,
        Item: { pk: pkSkr(z.firma, p.cel), sk: z.id, gsi1pk: gsiPk(z.firma, p.cel), gsi1sk: `${p.stan}#${z.utworzono}`, zadanieId: z.id },
      },
    },
  ]);
  if (wynik !== 'OK') return null;
  const po: Record<string, unknown> = { ...z, ...pola };
  for (const k of usun) delete po[k];
  return po as unknown as Zadanie;
}

/** Warunek: właścicielem zadania jest `osoba`. */
const warunekWlasciciela = (osoba: string): Warunek => ({ wyr: '#wl = :os', nazwy: { '#wl': 'wlasciciel' }, wartosci: { ':os': osoba } });

/**
 * Przekazanie zadania innej osobie (np. autorowi PR po code review): tylko właściciel; zadanie wraca do `nowe`
 * z jedynym kandydatem `doOsoby`, bez właściciela, a przekazujący zostaje nadawcą (może dostać odrzucenie).
 */
export async function przekaz(firma: string, idZadania: string, odOsoby: string, doOsoby: string, postep: string): Promise<Zadanie | null> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z || z.wlasciciel !== odOsoby || z.stan === 'usuniete') return null;
  const w = warunekWlasciciela(odOsoby);
  return przeniesDo(z, { cel: doOsoby, stan: 'nowe', pola: { postep, nadawca: odOsoby }, usun: ['odrzucenie', 'uwagi', 'akceptujacy', 'oddano'] },
    { wyr: `${w.wyr} AND #st <> :usun`, nazwy: { ...w.nazwy, '#st': 'stan' }, wartosci: { ...w.wartosci, ':usun': 'usuniete' } });
}

export type WynikOdrzuc =
  | { ok: true; zadanie: Zadanie }
  | { ok: false; kod: 'NIE_ZNALEZIONO' | 'BRAK_DOSTEPU' | 'BRAK_NADAWCY' | 'KONFLIKT' };

const OCZEKUJACE: readonly string[] = ['nowe', 'eskalowane'];
/** Stany wziętego zadania, które właściciel może jeszcze odrzucić. */
const W_PRACY: readonly string[] = ['wziete', 'w_trakcie', 'do_akceptacji'];

/**
 * Odrzucenie zadania przez kandydata (niewzięte) lub właściciela.
 *
 * Wywołanie: `await odrzuc(firma, id, osoba, powod)`.
 * Oczekuje: sprawdzony powód (krótki tekst osoby).
 * Wynik: przy kilku kandydatach niewziętego zadania — zadanie bez
 * odrzucającego; inaczej stan `odrzucone` u nadawcy (właściciel),
 * z `odrzucenie` i postępem. Kody błędów jak w `WynikOdrzuc`.
 */
export async function odrzuc(firma: string, idZadania: string, osoba: string, powod: string): Promise<WynikOdrzuc> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z) return { ok: false, kod: 'NIE_ZNALEZIONO' };
  if (!z.nadawca) return { ok: false, kod: 'BRAK_NADAWCY' };
  const czeka = !z.wlasciciel && OCZEKUJACE.includes(z.stan);
  if (z.wlasciciel !== osoba && !(czeka && z.kandydaci.includes(osoba))) return { ok: false, kod: 'BRAK_DOSTEPU' };
  if (!czeka && !W_PRACY.includes(z.stan)) return { ok: false, kod: 'KONFLIKT' };
  const warunek: Warunek = czeka
    ? { wyr: '#st = :st AND attribute_not_exists(#wl) AND size(#kan) = :n', nazwy: { '#st': 'stan', '#wl': 'wlasciciel', '#kan': 'kandydaci' }, wartosci: { ':st': z.stan, ':n': z.kandydaci.length } }
    : { wyr: '#wl = :os AND #st = :st', nazwy: { '#wl': 'wlasciciel', '#st': 'stan' }, wartosci: { ':os': osoba, ':st': z.stan } };
  const zadanie = czeka && z.kandydaci.length > 1
    ? await odejdzKandydat(z, osoba, warunek)
    : await przeniesDo(z, {
      cel: z.nadawca, stan: 'odrzucone', wlasciciel: z.nadawca,
      pola: { postep: `Odrzucone przez ${osoba}`, odrzucenie: { osoba, powod } }, usun: ['uwagi', 'akceptujacy', 'oddano'],
    }, warunek);
  return zadanie ? { ok: true, zadanie } : { ok: false, kod: 'KONFLIKT' };
}

/**
 * Usuwa jednego kandydata z niewziętego zadania (jego skrzynka też).
 *
 * Wywołanie: `await odejdzKandydat(z, osoba, warunek)`.
 * Oczekuje: zadanie z kilkoma kandydatami.
 * Wynik: zadanie bez tej osoby albo null, gdy warunek nie przeszedł.
 */
async function odejdzKandydat(z: Zadanie, osoba: string, w: Warunek): Promise<Zadanie | null> {
  const T = nazwaTabeli();
  const kandydaci = z.kandydaci.filter((o) => o !== osoba);
  const wynik = await transakcja([
    {
      Update: {
        TableName: T, Key: { pk: pkZad(z.firma), sk: z.id }, ConditionExpression: w.wyr,
        UpdateExpression: 'SET #kan = :kan', ExpressionAttributeNames: { ...w.nazwy, '#kan': 'kandydaci' },
        ExpressionAttributeValues: { ...w.wartosci, ':kan': kandydaci },
      },
    },
    { Delete: { TableName: T, Key: { pk: pkSkr(z.firma, osoba), sk: z.id } } },
  ]);
  return wynik === 'OK' ? { ...z, kandydaci } : null;
}

/**
 * Usunięcie odrzuconego zadania przez nadawcę (właściciela).
 *
 * Wywołanie: `await usunOdrzucone(firma, id, osoba)`.
 * Oczekuje: zadanie w stanie `odrzucone`.
 * Wynik: `ok` z zadaniem w stanie `usuniete` albo kod błędu.
 */
export async function usunOdrzucone(firma: string, idZadania: string, osoba: string): Promise<WynikOdrzuc> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z) return { ok: false, kod: 'NIE_ZNALEZIONO' };
  if (z.stan !== 'odrzucone') return { ok: false, kod: 'KONFLIKT' };
  if (z.wlasciciel !== osoba) return { ok: false, kod: 'BRAK_DOSTEPU' };
  const ok = await zmien(z, 'usuniete', '#wl = :os AND #stan = :odrz', { '#wl': 'wlasciciel', '#stan': 'stan' },
    { ':os': osoba, ':odrz': 'odrzucone' }, '#stan = :us', { ':us': 'usuniete' });
  return ok ? { ok: true, zadanie: { ...z, stan: 'usuniete' } } : { ok: false, kod: 'KONFLIKT' };
}

export type WynikAkceptacji =
  | { ok: true; zadanie: Zadanie }
  | { ok: false; kod: 'NIE_ZNALEZIONO' | 'BRAK_DOSTEPU' | 'KONFLIKT' };

/**
 * Oddanie zadania do akceptacji wskazanej osobie.
 *
 * Wywołanie: `await doAkceptacji(firma, id, wlasciciel, akceptujacy)`.
 * Oczekuje: sprawdzonego akceptującego (członek firmy, nie właściciel).
 * Wynik: zadanie `do_akceptacji` z `akceptujacy` i `oddano` (znacznik
 * rundy), ta osoba w kandydatach (wpis w skrzynce), bez dawnych
 * `uwagi`; opcjonalny postęp; kody błędów.
 */
export async function doAkceptacji(firma: string, idZadania: string, osoba: string, akceptujacy: string, postep?: string): Promise<WynikAkceptacji> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z) return { ok: false, kod: 'NIE_ZNALEZIONO' };
  if (z.wlasciciel !== osoba) return { ok: false, kod: 'BRAK_DOSTEPU' };
  if (!W_PRACY.includes(z.stan)) return { ok: false, kod: 'KONFLIKT' };
  const kandydaci = z.kandydaci.includes(akceptujacy) ? z.kandydaci : [...z.kandydaci, akceptujacy];
  if (kandydaci.length > 99) return { ok: false, kod: 'KONFLIKT' }; // limit transakcji: 100 elementów
  const oddano = new Date().toISOString();
  const T = nazwaTabeli();
  const wynik = await transakcja([
    {
      Update: {
        TableName: T, Key: { pk: pkZad(firma), sk: z.id },
        // size(#kan): równoległe wskazanie innej osoby nie zostawi osieroconego wpisu skrzynki
        ConditionExpression: '#wl = :os AND #st = :byl AND size(#kan) = :n',
        UpdateExpression: `SET #st = :dak, #ak = :ak, #kan = :kan, #od = :od${postep !== undefined ? ', #po = :po' : ''} REMOVE #uw`,
        ExpressionAttributeNames: {
          '#wl': 'wlasciciel', '#st': 'stan', '#ak': 'akceptujacy', '#kan': 'kandydaci', '#uw': 'uwagi', '#od': 'oddano',
          ...(postep !== undefined ? { '#po': 'postep' } : {}),
        },
        ExpressionAttributeValues: {
          ':os': osoba, ':byl': z.stan, ':n': z.kandydaci.length, ':dak': 'do_akceptacji', ':ak': akceptujacy, ':kan': kandydaci, ':od': oddano,
          ...(postep !== undefined ? { ':po': postep } : {}),
        },
      },
    },
    ...kandydaci.map((o) => ({
      Put: { TableName: T, Item: { pk: pkSkr(firma, o), sk: z.id, gsi1pk: gsiPk(firma, o), gsi1sk: `do_akceptacji#${z.utworzono}`, zadanieId: z.id } },
    })),
  ]);
  if (wynik !== 'OK') return { ok: false, kod: 'KONFLIKT' };
  const { uwagi: _uw, ...reszta } = z;
  return { ok: true, zadanie: { ...reszta, stan: 'do_akceptacji', akceptujacy, kandydaci, oddano, ...(postep !== undefined ? { postep } : {}) } };
}

/**
 * Decyzja akceptującego: akceptacja albo odesłanie do poprawy.
 *
 * Wywołanie: `await rozstrzygnij(firma, id, osoba, powod?)` — bez
 * powodu akceptuje, z powodem odsyła do poprawy.
 * Oczekuje: sprawdzonego powodu (gdy podany).
 * Wynik: `zrobione` („Zaakceptowane przez X”) albo `w_trakcie` z
 * `uwagi` („Do poprawy (X)”), w obu bez `akceptujacy`; kody błędów:
 * KONFLIKT, gdy zadanie nie czeka na akceptację.
 */
export async function rozstrzygnij(firma: string, idZadania: string, osoba: string, powod?: string): Promise<WynikAkceptacji> {
  const z = await pobierzZadanie(firma, idZadania);
  if (!z) return { ok: false, kod: 'NIE_ZNALEZIONO' };
  if (!z.kandydaci.includes(osoba) && z.wlasciciel !== osoba) return { ok: false, kod: 'BRAK_DOSTEPU' };
  if (z.stan !== 'do_akceptacji') return { ok: false, kod: 'KONFLIKT' };
  if (z.akceptujacy !== osoba) return { ok: false, kod: 'BRAK_DOSTEPU' };
  const stan: StanZadania = powod === undefined ? 'zrobione' : 'w_trakcie';
  const postep = powod === undefined ? `Zaakceptowane przez ${osoba}` : `Do poprawy (${osoba})`;
  const uwagi = powod === undefined ? undefined : { osoba, powod, czas: new Date().toISOString() };
  const ok = await zmien(
    z, stan, '#st = :dak AND #ak = :os',
    { '#st': 'stan', '#ak': 'akceptujacy', '#po': 'postep', ...(powod !== undefined ? { '#uw': 'uwagi' } : {}) },
    { ':dak': 'do_akceptacji', ':os': osoba },
    `#st = :nowy, #po = :po${powod !== undefined ? ', #uw = :uw' : ''} REMOVE #ak`,
    { ':nowy': stan, ':po': postep, ...(uwagi ? { ':uw': uwagi } : {}) },
  );
  if (!ok) return { ok: false, kod: 'KONFLIKT' };
  const { akceptujacy: _ak, ...reszta } = z;
  return { ok: true, zadanie: { ...reszta, stan, postep, ...(uwagi ? { uwagi } : {}) } };
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
