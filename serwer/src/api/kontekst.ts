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

export async function kontekst(event: ZdarzenieApi): Promise<Kontekst> {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub === '') throw new HttpBlad(401, 'BRAK_TOKENU');

  const firmy = await tozsamosc(sub);
  if (!firmy) throw new HttpBlad(403, 'BRAK_DOSTEPU');
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
