import { tozsamosc } from '../dane/konfiguracja.js';
import { dostepFirmy } from './dostepPlatformy.js';

/** Minimalny kształt zdarzenia API Gateway HTTP API (payload v2) — tylko to, czego używamy. */
export interface ZdarzenieApi {
  routeKey: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
}

export interface Kontekst { sub: string; firma: string; osoba: string }
export interface Odpowiedz { status: number; body: unknown }

/** Błąd HTTP z kodem aplikacyjnym; do klienta trafia wyłącznie `{kod, ...dodatkowe}`. */
export class HttpBlad extends Error {
  constructor(readonly status: number, readonly kod: string, readonly dodatkowe: Record<string, unknown> = {}) {
    super(kod);
  }
}

/** `sub` z tokenu JWT (zweryfikowanego przez API Gateway); brak → 401. */
export function subZTokenu(event: ZdarzenieApi): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub === '') throw new HttpBlad(401, 'BRAK_TOKENU');
  return sub;
}

/** Outcome of checking the CogniFly licence claim of a token. */
export type LicenceState = 'OK' | 'BRAK_LICENCJI' | 'LICENCJA_WYGASLA';

/** Name of the licence claim; `COGNIFLY_LICENCE_CLAIM`, read at call time. */
function licenceClaimName(): string {
  return process.env.COGNIFLY_LICENCE_CLAIM || 'lic_cognifly';
}

/**
 * Checks the licence claim (ISO 8601 instant = start of the day after the
 * licence ends). Valid only while `now < Date.parse(claim)`. A missing or
 * unparsable claim means no licence. Pure: `now` is injected (epoch ms).
 */
export function licenceState(claims: Record<string, unknown> | undefined, now: number): LicenceState {
  const raw = claims?.[licenceClaimName()];
  const until = typeof raw === 'string' && raw !== '' ? Date.parse(raw) : NaN;
  if (Number.isNaN(until)) return 'BRAK_LICENCJI';
  return now < until ? 'OK' : 'LICENCJA_WYGASLA';
}

/** Platforma reasons of a missing or expired licence → API codes. */
const KODY_LICENCJI: Record<string, LicenceState> = { NO_LICENCE: 'BRAK_LICENCJI', LICENCE_EXPIRED: 'LICENCJA_WYGASLA' };

/** Company named by the `X-Cognifly-Firma` header; '' when absent. */
function naglowekFirmy(event: ZdarzenieApi): string {
  return event.headers?.['x-cognifly-firma'] ?? '';
}

/** Raw bearer token of the request; '' when absent. */
function tokenOsoby(event: ZdarzenieApi): string {
  const h = event.headers?.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
}

/**
 * Checks the licence claim of the token (the fast path).
 *
 * Call: `wymagajLicencjiZClaimu(event)`.
 * Expects: an API event.
 * Output: none when the claim is valid.
 * Throws: 403 `BRAK_LICENCJI` / `LICENCJA_WYGASLA` otherwise.
 */
function wymagajLicencjiZClaimu(event: ZdarzenieApi): void {
  const stan = licenceState(event.requestContext?.authorizer?.jwt?.claims, Date.now());
  if (stan !== 'OK') throw new HttpBlad(403, stan);
}

/**
 * Tells whether the token's claim decides the licence.
 *
 * Call: `claimRozstrzyga(event)`.
 * Expects: an API event.
 * Output: true when the token has the licence claim and either no
 * company header or the header equals the token's `org` claim.
 * Platforma v2 leaves the claim out for a person in several
 * companies, so then Platforma is asked instead.
 */
function claimRozstrzyga(event: ZdarzenieApi): boolean {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const raw = claims?.[licenceClaimName()];
  if (typeof raw !== 'string' || raw === '') return false;
  const firma = naglowekFirmy(event);
  return firma === '' || claims?.org === firma;
}

/**
 * Companies whose licence lets the request through.
 *
 * Call: `firmyDoSprawdzenia(event, firmy)`.
 * Expects: an API event and the person's companies.
 * Output: the header company when the person belongs to it; else
 * all their companies in order (any licensed one lets `GET /ja`
 * through, so a stale stored company can be replaced); `['']` for
 * a person without companies (Platforma chooses).
 */
function firmyDoSprawdzenia(event: ZdarzenieApi, firmy: Record<string, string>): string[] {
  const naglowek = naglowekFirmy(event);
  if (naglowek !== '' && Object.hasOwn(firmy, naglowek)) return [naglowek];
  const wszystkie = Object.keys(firmy).sort();
  return wszystkie.length > 0 ? wszystkie : [''];
}

/**
 * Error of a refusal by Platforma.
 *
 * Call: `throw odmowaPlatformy('NO_LICENCE')`.
 * Expects: a reason code of `GET /access`.
 * Output: 403 `BRAK_LICENCJI` / `LICENCJA_WYGASLA` for licence
 * reasons; 403 `BRAK_DOSTEPU` with `powod` for the others.
 */
function odmowaPlatformy(powod: string): HttpBlad {
  const kod = KODY_LICENCJI[powod];
  return kod ? new HttpBlad(403, kod) : new HttpBlad(403, 'BRAK_DOSTEPU', { powod });
}

/**
 * Checks the licence with Platforma (`GET /access`, cached 5 min).
 *
 * Call: `await wymagajLicencjiZPlatformy(event, ['pilot'])`.
 * Expects: an API event and the companies to try in order.
 * Output: none when a company is active, or when Platforma does not
 * answer (a network error never blocks work); without
 * `TOZSAMOSC_URL` or a bearer token only the claim counts.
 * Throws: the first refusal (`odmowaPlatformy`) when all refuse.
 */
async function wymagajLicencjiZPlatformy(event: ZdarzenieApi, firmy: string[]): Promise<void> {
  const adres = process.env.TOZSAMOSC_URL ?? '';
  const token = tokenOsoby(event);
  if (adres === '' || token === '') return wymagajLicencjiZClaimu(event);
  let odmowa: string | null = null;
  for (const firma of firmy) {
    const d = await dostepFirmy(adres, token, firma);
    if (d === null || d.aktywny) return;
    odmowa ??= d.powod;
  }
  throw odmowaPlatformy(odmowa ?? 'UNKNOWN');
}

/**
 * The person's companies (company → person id), licence checked.
 *
 * Call: `await firmyZTokenu(event)`.
 * Expects: an event verified by the JWT authorizer.
 * Output: `{sub, firmy}`. The licence claim is checked before the
 * registry read when it decides (`claimRozstrzyga`); otherwise
 * Platforma is asked for the header company (or any company).
 * Throws: 401 without `sub`; 403 for an unknown person or a
 * missing licence (`BRAK_LICENCJI`, `LICENCJA_WYGASLA`,
 * `BRAK_DOSTEPU` with `powod`).
 */
export async function firmyZTokenu(event: ZdarzenieApi): Promise<{ sub: string; firmy: Record<string, string> }> {
  const sub = subZTokenu(event);
  const zClaimu = claimRozstrzyga(event);
  if (zClaimu) wymagajLicencjiZClaimu(event);
  const firmy = await tozsamosc(sub);
  if (!firmy) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  if (!zClaimu) await wymagajLicencjiZPlatformy(event, firmyDoSprawdzenia(event, firmy));
  return { sub, firmy };
}

export async function kontekst(event: ZdarzenieApi): Promise<Kontekst> {
  const { sub, firmy } = await firmyZTokenu(event);
  const dostepne = Object.keys(firmy);

  const naglowek = naglowekFirmy(event);
  let firma: string;
  if (naglowek !== '') {
    if (!Object.hasOwn(firmy, naglowek)) throw new HttpBlad(403, 'BRAK_DOSTEPU');
    firma = naglowek;
  } else if (dostepne.length === 1) {
    firma = dostepne[0]!;
  } else if (dostepne.length === 0) {
    throw new HttpBlad(403, 'BRAK_DOSTEPU');
  } else {
    throw new HttpBlad(400, 'BRAK_FIRMY');
  }
  const osoba = firmy[firma];
  if (typeof osoba !== 'string' || osoba === '') throw new HttpBlad(403, 'BRAK_DOSTEPU');
  return { sub, firma, osoba };
}

/** Treść żądania jako obiekt JSON albo 400. */
export function obiektJson(surowe: string | null | undefined): Record<string, unknown> {
  let b: unknown;
  try { b = JSON.parse(surowe ?? ''); } catch { throw new HttpBlad(400, 'ZLY_JSON'); }
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpBlad(400, 'ZLE_DANE');
  return b as Record<string, unknown>;
}
