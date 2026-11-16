import { pobierzZadanie, ustawStan, wez, type StanZadania } from '../dane/kolejka.js';
import { HttpBlad, type Kontekst, type Odpowiedz } from './kontekst.js';

const ID = /^zad_(?:[0-9a-f]{12}|[0-9a-f]{24})$/; // 12 hex: utworzZadanie bez id; 24 hex: id z zdarzenia (przetwarzanie)
const DOZWOLONE = ['w_trakcie', 'do_akceptacji', 'zrobione'] as const;

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
  let b: unknown;
  try { b = JSON.parse(surowe ?? ''); } catch { throw new HttpBlad(400, 'ZLY_JSON'); }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpBlad(400, 'ZLE_DANE');
  const { stan: s, postep } = b as { stan?: unknown; postep?: unknown };
  if (typeof s !== 'string' || !(DOZWOLONE as readonly string[]).includes(s)) throw new HttpBlad(400, 'ZLY_STAN');
  if (postep !== undefined && (typeof postep !== 'string' || postep.length > 200)) throw new HttpBlad(400, 'ZLY_POSTEP');
  if (!(await ustawStan(k.firma, zid, k.osoba, s as StanZadania, postep))) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  return { status: 200, body: { zadanie: await pobierzZadanie(k.firma, zid) } };
}
