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

/**
 * ASCII marker of the error logged for a misconfiguration answer;
 * the metric filter of the API alarm in `infra/lib/stos.ts` matches it.
 */
export const ZLA_ODPOWIEDZ = 'DOSTEP_ZLA_ODPOWIEDZ';

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

/** Reasons about the company or licence that may stand in during an outage. */
const POWODY_ZAPASU: readonly string[] = ['NO_LICENCE', 'LICENCE_EXPIRED', 'ORG_SUSPENDED', 'NOT_MEMBER'];

/** Answers with their time, by key; never more than `PAMIEC_MAX`. */
class Pamiec {
  private readonly wpisy = new Map<string, { dostep: Dostep; czas: number }>();

  /** Forgets everything (tests). */
  wyczysc(): void {
    this.wpisy.clear();
  }

  /**
   * Answer younger than a limit.
   *
   * Call: `pamiec.odczytaj(klucz, now, WAZNOSC_MS)`.
   * Expects: a key, the current time and the age limit (ms).
   * Output: the answer, or null when none is young enough.
   */
  odczytaj(k: string, now: number, limit: number): Dostep | null {
    const z = this.wpisy.get(k);
    return z && now - z.czas < limit ? z.dostep : null;
  }

  /**
   * Remembers an answer with its time.
   *
   * Call: `pamiec.zapisz(klucz, dostep, now)`.
   * Expects: a key, an answer and the current time (ms).
   * Output: none; when full, entries older than `ZAPAS_MS` go first,
   * then the oldest ones.
   */
  zapisz(k: string, dostep: Dostep, now: number): void {
    if (this.wpisy.size >= PAMIEC_MAX) {
      for (const [x, e] of this.wpisy) if (now - e.czas >= ZAPAS_MS) this.wpisy.delete(x);
      for (const x of this.wpisy.keys()) {
        if (this.wpisy.size < PAMIEC_MAX) break;
        this.wpisy.delete(x);
      }
    }
    this.wpisy.delete(k);
    this.wpisy.set(k, { dostep, czas: now });
  }
}

/** Fresh answers by `sha256(token)|firma` (5 min); tokens are never kept. */
const swieze = new Pamiec();

/** Outage fallback by `sub|firma` (60 min): survives token refreshes. */
const zapas = new Pamiec();

/** Empties both memories (tests). */
export function wyczyscPamiecDostepu(): void {
  swieze.wyczysc();
  zapas.wyczysc();
}

/**
 * Key of one (token, company) pair.
 *
 * Call: `kluczTokenu(token, 'pilot')`.
 * Expects: the raw token and a company ('' for none).
 * Output: hex SHA-256 of the token, `|` and the company.
 */
function kluczTokenu(token: string, firma: string): string {
  return `${createHash('sha256').update(token).digest('hex')}|${firma}`;
}

/**
 * Tells whether an answer may serve as the outage fallback.
 *
 * Call: `doZapasu(dostep)`.
 * Expects: an answer of Platforma.
 * Output: true for a consent and for company or licence reasons
 * (`POWODY_ZAPASU`); false for reasons about the token or account
 * (`TOKEN_REVOKED`, `ACCOUNT_DISABLED`, ...), which a new token of
 * the same person may not share.
 */
function doZapasu(dostep: Dostep): boolean {
  return dostep.aktywny || POWODY_ZAPASU.includes(dostep.powod);
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
 * error, timeout also while reading the body, 5xx, 429; logged as
 * a warning).
 * Throws: `BladTozsamosci` for another non-200 status or an odd
 * body (logged as an error).
 */
async function zapytaj(adres: string, token: string, firma: string): Promise<Dostep | null> {
  const q = new URLSearchParams({ product: 'cognifly' });
  if (firma) q.set('org', firma);
  let r: Response;
  let tresc = '';
  try {
    r = await fetch(`${adres.replace(/\/+$/, '')}/access?${q}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LIMIT_MS),
    });
    if (r.status === 200) tresc = await r.text();
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
    return odczytaj(parsuj(tresc));
  } catch (e) {
    console.error(`${ZLA_ODPOWIEDZ} zła odpowiedź /access (konfiguracja?)`, e instanceof Error ? e.message : e);
    throw e;
  }
}

/**
 * Parses the text of a 200 answer.
 *
 * Call: `parsuj(tresc)`.
 * Expects: the body text.
 * Output: the parsed JSON.
 * Throws: `BladTozsamosci` when the text is not JSON.
 */
function parsuj(tresc: string): unknown {
  try {
    return JSON.parse(tresc);
  } catch {
    throw new BladTozsamosci('treść nie jest JSON');
  }
}

/**
 * Access of a person to CogniFly in a company.
 *
 * Call: `await dostepFirmy(adres, token, sub, firma)`.
 * Expects: the Identity base URL, the person's ACCESS token, their
 * verified `sub` and a company ('' lets Platforma choose).
 * Output: an answer for this token younger than 5 min, else a fresh
 * one (remembered per token; consents and company or licence
 * refusals also per `sub|firma`). When Platforma is down: the last
 * such answer of this person and company up to 60 min old
 * (stale-if-error, also after a token refresh), else null (the
 * caller lets the request through).
 * Throws: `BladTozsamosci` (see `zapytaj`).
 */
export async function dostepFirmy(adres: string, token: string, sub: string, firma: string): Promise<Dostep | null> {
  const now = Date.now();
  const kt = kluczTokenu(token, firma);
  const ko = `${sub}|${firma}`;
  const swiezy = swieze.odczytaj(kt, now, WAZNOSC_MS);
  if (swiezy) return swiezy;
  const dostep = await zapytaj(adres, token, firma);
  if (!dostep) return zapas.odczytaj(ko, now, ZAPAS_MS);
  swieze.zapisz(kt, dostep, now);
  if (doZapasu(dostep)) zapas.zapisz(ko, dostep, now);
  return dostep;
}
