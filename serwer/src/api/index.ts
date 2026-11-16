import { kontekst, HttpBlad, type Odpowiedz, type ZdarzenieApi } from './kontekst.js';
import { podsumowanie, skrzynkaOsoby } from './skrzynka.js';
import { ja } from './ja.js';
import { biore, przekaz, stan, szczegoly } from './zadania.js';
import { zdarzenia } from './zdarzenia.js';

const NAGLOWKI = { 'content-type': 'application/json' };
const odp = (o: Odpowiedz) => ({ statusCode: o.status, headers: NAGLOWKI, body: JSON.stringify(o.body) });

function tresc(e: ZdarzenieApi): string | null | undefined {
  return e.isBase64Encoded && e.body ? Buffer.from(e.body, 'base64').toString('utf8') : e.body;
}

export async function handler(event: ZdarzenieApi) {
  try {
    const trasy: Record<string, (k: Awaited<ReturnType<typeof kontekst>>) => Promise<Odpowiedz>> = {
      'GET /zdarzenia': (k) => zdarzenia(k, event.queryStringParameters),
      'GET /skrzynka': (k) => skrzynkaOsoby(k),
      'GET /zadania/{id}': (k) => szczegoly(k, event.pathParameters?.id),
      'POST /zadania/{id}/biore': (k) => biore(k, event.pathParameters?.id),
      'POST /zadania/{id}/stan': (k) => stan(k, event.pathParameters?.id, tresc(event)),
      'POST /zadania/{id}/przekaz': (k) => przekaz(k, event.pathParameters?.id, tresc(event)),
      'GET /podsumowanie': (k) => podsumowanie(k),
    };
    if (event.routeKey === 'GET /ja') return odp(await ja(event)); // bez kontekstu firmy
    const trasa = Object.hasOwn(trasy, event.routeKey) ? trasy[event.routeKey] : undefined;
    if (!trasa) return odp({ status: 404, body: { kod: 'NIE_ZNALEZIONO' } });
    return odp(await trasa(await kontekst(event)));
  } catch (e) {
    if (e instanceof HttpBlad) return odp({ status: e.status, body: { kod: e.kod, ...e.dodatkowe } });
    console.error('Błąd API', e); // szczegóły tylko w logu, nigdy w odpowiedzi
    return odp({ status: 500, body: { kod: 'BLAD' } });
  }
}
