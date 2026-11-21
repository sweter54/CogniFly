// Access to CogniFly in one company as Platforma Identity sees it
// (`GET <TOZSAMOSC_URL>/access?product=cognifly&org=<firma>`, asked
// with the person's token), remembered in the Lambda's memory.
import { createHash } from 'node:crypto';

/** Answer of Platforma: active, or inactive with a reason code. */
export type Dostep = { aktywny: true } | { aktywny: false; powod: string };

/** How long one answer is reused without asking again (5 min). */
export const WAZNOSC_MS = 300_000;

/** How long an answer may stand in when Platforma is down (60 min, like the claim). */
export const ZAPAS_MS = 3_600_000;

/** Most answers kept by one Lambda instance. */
export const PAMIEC_MAX = 1000;

/** Time limit of one `GET /access` call. */
const LIMIT_MS = 1_500;

/** Shape of a reason code accepted from the network. */
const WZOR_POWODU = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Statuses that mean "Platforma is down for now" (not a refusal). */
const AWARIA = (status: number): boolean => status >= 500 || status === 429;

/**
 * Platforma answered in a way that points at a misconfiguration
 * (a 4xx other than 429, or a body without a boolean `active`).
 */
export class BladTozsamosci extends Error {
  constructor(opis: string) {
    super(opis);
    this.name = 'BladTozsamosci';
  }
}

/** Remembered answers by `sha256(token)|firma` with the answer time; tokens are never kept. */
const pamiec = new Map<string, { dostep: Dostep; czas: number }>();

/** Empties the memory of answers (tests). */
export function wyczyscPamiecDostepu(): void {
  pamiec.clear();
}

/**
 * Key of one (token, company) pair.
 *
 * Call: `klucz(token, 'pilot')`.
 * Expects: the raw token and a company ('' for none).
 * Output: hex SHA-256 of the token, `|` and the company.
 */
function klucz(token: string, firma: string): string {
  return `${createHash('sha256').update(token).digest('hex')}|${firma}`;
}

/**
 * Remembers an answer with its time.
 *
 * Call: `zapamietaj(klucz, dostep, now)`.
 * Expects: a key, an answer and the current time (ms).
 * Output: none; when full, entries older than `ZAPAS_MS` go first,
 * then the oldest ones, so the map never exceeds `PAMIEC_MAX`.
 */
function zapamietaj(k: string, dostep: Dostep, now: number): void {
  if (pamiec.size >= PAMIEC_MAX) {
    for (const [x, e] of pamiec) if (now - e.czas >= ZAPAS_MS) pamiec.delete(x);
    for (const x of pamiec.keys()) {
      if (pamiec.size < PAMIEC_MAX) break;
      pamiec.delete(x);
    }
  }
  pamiec.delete(k);
  pamiec.set(k, { dostep, czas: now });
}

/**
 * Remembered answer younger than a limit.
 *
 * Call: `zPamieci(klucz, now, WAZNOSC_MS)`.
 * Expects: a key, the current time and the age limit (ms).
 * Output: the answer, or null when none is young enough.
 */
function zPamieci(k: string, now: number, limit: number): Dostep | null {
  const z = pamiec.get(k);
  return z && now - z.czas < limit ? z.dostep : null;
}

/**
 * Reads the body of a 200 answer of `GET /access`.
 *
 * Call: `odczytaj(json)`.
 * Expects: anything.
 * Output: the answer; a missing or odd reason becomes `UNKNOWN`.
 * Throws: `BladTozsamosci` when `active` is not a boolean.
 */
function odczytaj(json: unknown): Dostep {
  const b = (typeof json === 'object' && json !== null ? json : {}) as { active?: unknown; reason?: unknown };
  if (b.active === true) return { aktywny: true };
  if (b.active !== false) throw new BladTozsamosci('treść bez pola active');
  const powod = typeof b.reason === 'string' && WZOR_POWODU.test(b.reason) ? b.reason : 'UNKNOWN';
  return { aktywny: false, powod };
}

/**
 * Asks Platforma once, without memory.
 *
 * Call: `await zapytaj(adres, token, 'pilot')`.
 * Expects: the Identity base URL, the person's token, a company.
 * Output: the answer, or null when Platforma is down (network
 * error, timeout, 5xx, 429; logged as a warning).
 * Throws: `BladTozsamosci` for another non-200 status or an odd
 * body (logged as an error).
 */
async function zapytaj(adres: string, token: string, firma: string): Promise<Dostep | null> {
  const q = new URLSearchParams({ product: 'cognifly' });
  if (firma) q.set('org', firma);
  let r: Response;
  let json: unknown;
  try {
    r = await fetch(`${adres.replace(/\/+$/, '')}/access?${q}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LIMIT_MS),
    });
    json = r.status === 200 ? await r.json().catch(() => undefined) : undefined;
  } catch (e) {
    console.warn('dostep: /access nieosiągalny', e instanceof Error ? e.name : typeof e);
    return null;
  }
  if (AWARIA(r.status)) {
    console.warn('dostep: /access chwilowo niedostępny', r.status);
    return null;
  }
  try {
    if (r.status !== 200) throw new BladTozsamosci(`status ${r.status}`);
    return odczytaj(json);
  } catch (e) {
    console.error('dostep: zła odpowiedź /access (konfiguracja?)', e instanceof Error ? e.message : e);
    throw e;
  }
}

/**
 * Access of a person to CogniFly in a company.
 *
 * Call: `await dostepFirmy(process.env.TOZSAMOSC_URL, token, firma)`.
 * Expects: the Identity base URL, the person's ACCESS token and a
 * company ('' lets Platforma choose).
 * Output: an answer younger than 5 min from memory, else a fresh one
 * (remembered). When Platforma is down: the last answer up to
 * 60 min old (stale-if-error), else null (the caller lets the
 * request through).
 * Throws: `BladTozsamosci` (see `zapytaj`).
 */
export async function dostepFirmy(adres: string, token: string, firma: string): Promise<Dostep | null> {
  const now = Date.now();
  const k = klucz(token, firma);
  const swiezy = zPamieci(k, now, WAZNOSC_MS);
  if (swiezy) return swiezy;
  const dostep = await zapytaj(adres, token, firma);
  if (dostep) zapamietaj(k, dostep, now);
  return dostep ?? zPamieci(k, now, ZAPAS_MS);
}
