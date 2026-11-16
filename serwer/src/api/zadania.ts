import type { Zdarzenie } from '@cognifly/wspolne';
import type { EventSummary } from '@cognifly/wspolne/api';
import { zdarzenieZadania } from '../dane/historia.js';
import { LOGIN_GITHUB, osobaPoLoginie } from '../dane/konfiguracja.js';
import { pobierzZadanie, przekaz as przekazZadanie, ustawStan, wez, type StanZadania } from '../dane/kolejka.js';
import { HttpBlad, type Kontekst, type Odpowiedz } from './kontekst.js';
import { TASK_ID_PATTERN as ID, USER_SETTABLE_STATES as DOZWOLONE } from '@cognifly/wspolne/api';
// ID: 12 hex = utworzZadanie bez id; 24 hex = id ze zdarzenia (przetwarzanie)

function sprawdzId(id: string | undefined): string {
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

/** Treść żądania jako obiekt JSON albo 400. */
function obiektJson(surowe: string | null | undefined): Record<string, unknown> {
  let b: unknown;
  try { b = JSON.parse(surowe ?? ''); } catch { throw new HttpBlad(400, 'ZLY_JSON'); }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpBlad(400, 'ZLE_DANE');
  return b as Record<string, unknown>;
}

/** POST /zadania/{id}/przekaz {doLoginu}: właściciel przekazuje zadanie osobie o danym loginie GitHub. */
export async function przekaz(k: Kontekst, id: string | undefined, surowe: string | null | undefined): Promise<Odpowiedz> {
  const zid = sprawdzId(id);
  const { doLoginu } = obiektJson(surowe);
  if (typeof doLoginu !== 'string' || !LOGIN_GITHUB.test(doLoginu)) throw new HttpBlad(400, 'ZLY_LOGIN');
  const z = await pobierzZadanie(k.firma, zid);
  if (!z) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (z.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  const osoba = await osobaPoLoginie(k.firma, doLoginu);
  if (!osoba) throw new HttpBlad(409, 'BRAK_OSOBY');
  const zadanie = await przekazZadanie(k.firma, zid, k.osoba, osoba, POSTEP_PRZEKAZANIA);
  if (!zadanie) throw new HttpBlad(409, 'KONFLIKT');
  return { status: 200, body: { zadanie } };
}
