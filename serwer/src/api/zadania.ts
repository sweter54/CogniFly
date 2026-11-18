import type { Zdarzenie } from '@cognifly/wspolne';
import type { EventSummary } from '@cognifly/wspolne/api';
import { zdarzenieZadania } from '../dane/historia.js';
import { LOGIN_GITHUB, osobaPoLoginie, osobyFirmy } from '../dane/konfiguracja.js';
import { odrzuc as odrzucZadanie, pobierzZadanie, przekaz as przekazZadanie, ustawStan, usunOdrzucone, wez, type StanZadania, type WynikOdrzuc } from '../dane/kolejka.js';
import { zapiszWatek } from '../dane/watki.js';
import { HttpBlad, obiektJson, type Kontekst, type Odpowiedz } from './kontekst.js';
import { TASK_ID_PATTERN as ID, THREAD_PATTERN, USER_SETTABLE_STATES as DOZWOLONE } from '@cognifly/wspolne/api';
// ID: 12 hex = utworzZadanie bez id; 24 hex = id ze zdarzenia (przetwarzanie)

export function sprawdzId(id: string | undefined): string {
  if (id === undefined || !ID.test(id)) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  return id;
}

export async function biore(k: Kontekst, id: string | undefined): Promise<Odpowiedz> {
  const w = await wez(k.firma, sprawdzId(id), k.osoba);
  if (w.ok) return { status: 200, body: { zadanie: w.zadanie } };
  if (w.kod === 'ZAJETE') throw new HttpBlad(409, 'ZAJETE', { wlasciciel: w.wlasciciel });
  if (w.kod === 'BRAK_DOSTEPU') throw new HttpBlad(403, 'BRAK_DOSTEPU');
  throw new HttpBlad(404, 'NIE_ZNALEZIONO');
}

export async function stan(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const { stan: s, postep } = obiektJson(surowe);
  if (typeof s !== 'string' || !(DOZWOLONE as readonly string[]).includes(s)) throw new HttpBlad(400, 'ZLY_STAN');
  if (postep !== undefined && (typeof postep !== 'string' || postep.length > 200)) throw new HttpBlad(400, 'ZLY_POSTEP');
  if (!(await ustawStan(k.firma, zid, k.osoba, s as StanZadania, postep))) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  return { status: 200, body: { zadanie: await pobierzZadanie(k.firma, zid) } };
}

/** Zdarzenie bez treści od obcych: bez `dane`, `daneRef` i nazwy gałęzi (`podmiot.galaz`). */
export function odchudzZdarzenie(z: Zdarzenie): EventSummary {
  const { galaz: _galaz, ...podmiot } = z.podmiot;
  return { id: z.id, czas: z.czas, zrodlo: z.zrodlo, typ: z.typ, opis: z.opis, podmiot, wymagaPracy: z.wymagaPracy };
}

/** GET /zadania/{id}: zadanie i jego zdarzenie — tylko dla kandydata lub właściciela (inaczej 403). */
export async function szczegoly(k: Kontekst, id: string | undefined): Promise<Odpowiedz> {
  const zadanie = await pobierzZadanie(k.firma, sprawdzId(id));
  if (!zadanie) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (!zadanie.kandydaci.includes(k.osoba) && zadanie.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  const z = await zdarzenieZadania(k.firma, zadanie.zdarzenieId, zadanie.utworzono);
  return { status: 200, body: { zadanie, zdarzenie: z ? odchudzZdarzenie(z) : null } };
}

const POSTEP_PRZEKAZANIA = 'Uwagi z code review do poprawy';
const POSTEP_PONOWNEGO = 'Przekazane ponownie';

/**
 * Resolves the handover target from the body.
 *
 * Call: `await adresat(firma, body)`.
 * Expects: `{doLoginu}` (GitHub login, CR handover) or `{doOsoby}`
 * (person of the company, e.g. after a rejection).
 * Output: the person id and the progress text to set.
 * Throws: 400 `ZLY_LOGIN`, 409 `BRAK_OSOBY`.
 */
async function adresat(firma: string, b: Record<string, unknown>): Promise<{ osoba: string; postep: string }> {
  if (typeof b.doOsoby === 'string') {
    const czlonek = (await osobyFirmy(firma)).some((o) => o.osoba === b.doOsoby);
    if (!czlonek) throw new HttpBlad(409, 'BRAK_OSOBY');
    return { osoba: b.doOsoby, postep: POSTEP_PONOWNEGO };
  }
  if (typeof b.doLoginu !== 'string' || !LOGIN_GITHUB.test(b.doLoginu)) throw new HttpBlad(400, 'ZLY_LOGIN');
  const osoba = await osobaPoLoginie(firma, b.doLoginu);
  if (!osoba) throw new HttpBlad(409, 'BRAK_OSOBY');
  return { osoba, postep: POSTEP_PRZEKAZANIA };
}

/** POST /zadania/{id}/przekaz {doLoginu | doOsoby}: właściciel przekazuje zadanie; zostaje jego nadawcą. */
export async function przekaz(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const b = obiektJson(surowe);
  const z = await pobierzZadanie(k.firma, zid);
  if (!z) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (z.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  const cel = await adresat(k.firma, b);
  const zadanie = await przekazZadanie(k.firma, zid, k.osoba, cel.osoba, cel.postep);
  if (!zadanie) throw new HttpBlad(409, 'KONFLIKT');
  return { status: 200, body: { zadanie } };
}

/**
 * Validates a rejection reason.
 *
 * Call: `powodOdrzucenia(value)`.
 * Expects: anything from the body.
 * Output: the trimmed reason (1–200 characters, no control chars).
 * Throws: 400 `ZLY_POWOD`.
 */
export function powodOdrzucenia(value: unknown): string {
  const p = typeof value === 'string' ? value.trim() : '';
  if (!p || p.length > 200 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(p)) throw new HttpBlad(400, 'ZLY_POWOD');
  return p;
}

/**
 * Maps a queue result to an HTTP answer.
 * Call: `odpowiedzZadania(wynik)`. Expects: a queue result.
 * Output: 200 `{zadanie}`; throws 404/403/409 for the error codes.
 */
function odpowiedzZadania(w: WynikOdrzuc): Odpowiedz {
  if (w.ok) return { status: 200, body: { zadanie: w.zadanie } };
  const status = { NIE_ZNALEZIONO: 404, BRAK_DOSTEPU: 403, BRAK_NADAWCY: 409, KONFLIKT: 409 }[w.kod];
  throw new HttpBlad(status, w.kod);
}

/** POST /zadania/{id}/odrzuc {powod}: kandydat lub właściciel odsyła zadanie nadawcy. */
export async function odrzuc(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const powod = powodOdrzucenia(obiektJson(surowe).powod);
  return odpowiedzZadania(await odrzucZadanie(k.firma, zid, k.osoba, powod));
}

/** POST /zadania/{id}/usun: nadawca usuwa odrzucone zadanie. */
export async function usun(k: Kontekst, id: string | undefined): Promise<Odpowiedz> {
  return odpowiedzZadania(await usunOdrzucone(k.firma, sprawdzId(id), k.osoba));
}

/** POST /zadania/{id}/watek {watek}: zapamiętuje wątek Claude Desktop osoby dla zadania. */
export async function watek(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const { watek: w } = obiektJson(surowe);
  if (typeof w !== 'string' || !THREAD_PATTERN.test(w)) throw new HttpBlad(400, 'ZLY_WATEK');
  const z = await pobierzZadanie(k.firma, zid);
  if (!z) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (!z.kandydaci.includes(k.osoba) && z.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  await zapiszWatek(k.firma, k.osoba, zid, w);
  return { status: 200, body: { watek: w } };
}
