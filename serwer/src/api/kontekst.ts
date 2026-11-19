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

/** Firmy osoby z tokenu (firma → osobaId); nieznana osoba → 403. */
export async function firmyZTokenu(event: ZdarzenieApi): Promise<{ sub: string; firmy: Record<string, string> }> {
  const sub = subZTokenu(event);
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
