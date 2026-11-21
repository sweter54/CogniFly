// Access to CogniFly in one company as Platforma Identity sees it
// (`GET <TOZSAMOSC_URL>/access?product=cognifly&org=<firma>`, asked
// with the person's token), remembered in the Lambda's memory.
import { createHash } from 'node:crypto';

/** Answer of Platforma: active, or inactive with a reason code. */
export type Dostep = { aktywny: true } | { aktywny: false; powod: string };

/** How long one answer is reused (5 min). */
export const WAZNOSC_MS = 300_000;

/** Most answers kept by one Lambda instance. */
export const PAMIEC_MAX = 1000;

/** Time limit of one `GET /access` call. */
const LIMIT_MS = 1_500;

/** Shape of a reason code accepted from the network. */
const WZOR_POWODU = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Remembered answers by `sha256(token)|firma`; tokens are never kept. */
const pamiec = new Map<string, { dostep: Dostep; do: number }>();

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
 * Remembers an answer for `WAZNOSC_MS`.
 *
 * Call: `zapamietaj(klucz, dostep, now)`.
 * Expects: a key, an answer and the current time (ms).
 * Output: none; when full, expired entries go first, then the
 * oldest ones, so the map never exceeds `PAMIEC_MAX`.
 */
function zapamietaj(k: string, dostep: Dostep, now: number): void {
  if (pamiec.size >= PAMIEC_MAX) {
    for (const [x, e] of pamiec) if (e.do <= now) pamiec.delete(x);
    for (const x of pamiec.keys()) {
      if (pamiec.size < PAMIEC_MAX) break;
      pamiec.delete(x);
    }
  }
  pamiec.delete(k);
  pamiec.set(k, { dostep, do: now + WAZNOSC_MS });
}

/**
 * Reads the body of a 200 answer of `GET /access`.
 *
 * Call: `odczytaj(json)`.
 * Expects: anything.
 * Output: the answer; a missing or odd reason becomes `UNKNOWN`;
 * null when `active` is not a boolean.
 */
function odczytaj(json: unknown): Dostep | null {
  const b = (typeof json === 'object' && json !== null ? json : {}) as { active?: unknown; reason?: unknown };
  if (b.active === true) return { aktywny: true };
  if (b.active !== false) return null;
  const powod = typeof b.reason === 'string' && WZOR_POWODU.test(b.reason) ? b.reason : 'UNKNOWN';
  return { aktywny: false, powod };
}

/**
 * Asks Platforma once, without memory.
 *
 * Call: `await zapytaj(adres, token, 'pilot')`.
 * Expects: the Identity base URL, the person's token, a company.
 * Output: the answer, or null on a network error, a timeout, a
 * status other than 200 or an odd body (logged, never thrown).
 */
async function zapytaj(adres: string, token: string, firma: string): Promise<Dostep | null> {
  const q = new URLSearchParams({ product: 'cognifly' });
  if (firma) q.set('org', firma);
  try {
    const r = await fetch(`${adres.replace(/\/+$/, '')}/access?${q}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LIMIT_MS),
    });
    if (r.status !== 200) {
      console.warn('dostep: /access odpowiedział', r.status);
      return null;
    }
    return odczytaj(await r.json());
  } catch (e) {
    console.warn('dostep: /access nieosiągalny', e instanceof Error ? e.name : typeof e);
    return null;
  }
}

/**
 * Access of a person to CogniFly in a company, remembered 5 min.
 *
 * Call: `await dostepFirmy(process.env.TOZSAMOSC_URL, token, firma)`.
 * Expects: the Identity base URL, the person's ACCESS token and a
 * company ('' lets Platforma choose).
 * Output: the answer (positive and negative ones are remembered per
 * token and company for `WAZNOSC_MS`), or null when Platforma could
 * not answer (nothing is remembered then).
 */
export async function dostepFirmy(adres: string, token: string, firma: string): Promise<Dostep | null> {
  const now = Date.now();
  const k = klucz(token, firma);
  const z = pamiec.get(k);
  if (z && z.do > now) return z.dostep;
  const dostep = await zapytaj(adres, token, firma);
  if (dostep) zapamietaj(k, dostep, now);
  return dostep;
}
