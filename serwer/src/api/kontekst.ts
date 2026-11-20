import { tozsamosc } from '../dane/konfiguracja.js';

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

/** Throws 403 `BRAK_LICENCJI` / `LICENCJA_WYGASLA` unless the token is licensed. */
function wymagajLicencji(event: ZdarzenieApi): void {
  const stan = licenceState(event.requestContext?.authorizer?.jwt?.claims, Date.now());
  if (stan !== 'OK') throw new HttpBlad(403, stan);
}

/**
 * Firmy osoby z tokenu (firma → osobaId). Najpierw sprawdza licencję z
 * claimu (przed odczytem rejestru); nieznana osoba → 403.
 */
export async function firmyZTokenu(event: ZdarzenieApi): Promise<{ sub: string; firmy: Record<string, string> }> {
  const sub = subZTokenu(event);
  wymagajLicencji(event);
  const firmy = await tozsamosc(sub);
  if (!firmy) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  return { sub, firmy };
}

export async function kontekst(event: ZdarzenieApi): Promise<Kontekst> {
  const { sub, firmy } = await firmyZTokenu(event);
  const dostepne = Object.keys(firmy);

  const naglowek = event.headers?.['x-cognifly-firma'];
  let firma: string;
  if (naglowek !== undefined && naglowek !== '') {
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
