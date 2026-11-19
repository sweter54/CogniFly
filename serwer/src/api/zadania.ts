import type { Zdarzenie } from '@cognifly/wspolne';
import type { EventSummary, Task } from '@cognifly/wspolne/api';
import { zdarzenieZadania } from '../dane/historia.js';
import { LOGIN_GITHUB, osobaPoLoginie, osobyFirmy } from '../dane/konfiguracja.js';
import { doAkceptacji, odrzuc as odrzucZadanie, rozstrzygnij, pobierzZadanie, przekaz as przekazZadanie, ustawStan, usunOdrzucone, wez, type StanZadania, type WynikAkceptacji, type WynikOdrzuc } from '../dane/kolejka.js';
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
  const { stan: s, postep, akceptujacy } = obiektJson(surowe);
  if (typeof s !== 'string' || !(DOZWOLONE as readonly string[]).includes(s)) throw new HttpBlad(400, 'ZLY_STAN');
  if (postep !== undefined && (typeof postep !== 'string' || postep.length > 200)) throw new HttpBlad(400, 'ZLY_POSTEP');
  if (s === 'do_akceptacji') return oddajDoAkceptacji(k, zid, akceptujacy, postep as string | undefined);
  if (!(await ustawStan(k.firma, zid, k.osoba, s as StanZadania, postep))) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  return { status: 200, body: { zadanie: await pobierzZadanie(k.firma, zid) } };
}

/** Zdarzenie bez treści od obcych: bez `dane`, `daneRef` i nazwy gałęzi (`podmiot.galaz`). */
export function odchudzZdarzenie(z: Zdarzenie): EventSummary {
  const { galaz: _galaz, ...podmiot } = z.podmiot;
  return { id: z.id, czas: z.czas, zrodlo: z.zrodlo, typ: z.typ, opis: z.opis, podmiot, wymagaPracy: z.wymagaPracy };
}

/**
 * Tells whether a person takes part in a task.
 *
 * Call: `jestUczestnikiem(zadanie, osoba)`.
 * Expects: a task and a person id of its company.
 * Output: true for a candidate, the owner or the acceptor.
 */
export function jestUczestnikiem(
  z: Pick<Task, 'kandydaci' | 'wlasciciel' | 'akceptujacy'>, osoba: string,
): boolean {
  return z.kandydaci.includes(osoba) || z.wlasciciel === osoba || z.akceptujacy === osoba;
}

/**
 * GET /zadania/{id}: zadanie i jego zdarzenie, tylko dla
 * uczestnika (inaczej 403).
 */
export async function szczegoly(k: Kontekst, id: string | undefined): Promise<Odpowiedz> {
  const zadanie = await pobierzZadanie(k.firma, sprawdzId(id));
  if (!zadanie) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (!jestUczestnikiem(zadanie, k.osoba)) throw new HttpBlad(403, 'BRAK_DOSTEPU');
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
  if (cel.osoba === k.osoba) throw new HttpBlad(400, 'ZLA_OSOBA');
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
function odpowiedzZadania(w: WynikOdrzuc | WynikAkceptacji): Odpowiedz {
  if (w.ok) return { status: 200, body: { zadanie: w.zadanie } };
  const status = ({ NIE_ZNALEZIONO: 404, BRAK_DOSTEPU: 403, BRAK_NADAWCY: 409, KONFLIKT: 409 } as const)[w.kod];
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

/**
 * Hands the caller's task to a person for acceptance.
 *
 * Call: from `stan` for `do_akceptacji`.
 * Expects: `akceptujacy` from the body (optional: the sender then)
 * and an already checked `postep`.
 * Output: 200 `{zadanie}`.
 * Throws: 400 `BRAK_AKCEPTUJACEGO` / `ZLY_AKCEPTUJACY` (not a member,
 * or the owner), 403/404/409 from the queue.
 */
async function oddajDoAkceptacji(k: Kontekst, zid: string, wskazany: unknown, postep?: string): Promise<Odpowiedz> {
  const z = await pobierzZadanie(k.firma, zid);
  if (!z) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (z.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  const kto = wskazany ?? z.nadawca;
  if (kto === undefined) throw new HttpBlad(400, 'BRAK_AKCEPTUJACEGO');
  const czlonek = typeof kto === 'string' && (await osobyFirmy(k.firma)).some((o) => o.osoba === kto);
  if (!czlonek || kto === k.osoba) throw new HttpBlad(400, 'ZLY_AKCEPTUJACY');
  return odpowiedzZadania(await doAkceptacji(k.firma, zid, k.osoba, kto as string, postep));
}

/** POST /zadania/{id}/akceptuj: akceptujący zatwierdza zadanie (→ zrobione). */
export async function akceptuj(k: Kontekst, id: string | undefined): Promise<Odpowiedz> {
  return odpowiedzZadania(await rozstrzygnij(k.firma, sprawdzId(id), k.osoba));
}

/** POST /zadania/{id}/do-poprawy {powod}: akceptujący odsyła zadanie właścicielowi. */
export async function doPoprawy(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const powod = powodOdrzucenia(obiektJson(surowe).powod);
  return odpowiedzZadania(await rozstrzygnij(k.firma, zid, k.osoba, powod));
}
