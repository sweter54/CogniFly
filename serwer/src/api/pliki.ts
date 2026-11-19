import { tozsamosc } from '../dane/konfiguracja.js';
import { pobierzZadanie } from '../dane/kolejka.js';
import { intClient, type IntClient } from '../heartwood/klient.js';
import { workIdOf } from '../heartwood/praca.js';
import { HttpBlad, type Kontekst, type Odpowiedz } from './kontekst.js';
import { sprawdzId } from './zadania.js';

/**
 * Builds the Heartwood client from the environment.
 *
 * Call: `klientHeartwood()`.
 * Expects: `HEARTWOOD_INT_URL` (set only with the `heartwood` context)
 * and `AWS_REGION`.
 * Output: an `IntClient`, or null when the URL is not configured.
 */
export function klientHeartwood(): IntClient | null {
  const url = process.env.HEARTWOOD_INT_URL;
  if (!url) return null;
  return intClient({ url, region: process.env.AWS_REGION ?? 'eu-central-1' });
}

/**
 * Tells whether an entry's space may be shown to the caller.
 *
 * Call: `widoczna('user:sub-x', 'sub-me')`.
 * Expects: a Heartwood space id and the caller's `sub`.
 * Output: true for shared spaces and the caller's own private space.
 */
function widoczna(przestrzen: string, sub: string): boolean {
  return !przestrzen.startsWith('user:') || przestrzen === `user:${sub}`;
}

/**
 * Builds a resolver from Heartwood `sub`s to person ids of a company.
 *
 * Call: `const kto = resolver(firma); await kto(sub)`.
 * Expects: a company id.
 * Output: a cached function giving the person id or null (unknown).
 */
function resolver(firma: string): (sub: string | null) => Promise<string | null> {
  const pamiec = new Map<string, Promise<string | null>>();
  return (sub) => {
    if (sub === null) return Promise.resolve(null);
    if (!pamiec.has(sub)) pamiec.set(sub, tozsamosc(sub).then((f) => f?.[firma] ?? null));
    return pamiec.get(sub)!;
  };
}

/**
 * GET /zadania/{id}/pliki: locks and changes of a task, from Heartwood.
 *
 * Call: `await pliki(kontekst, id, klientHeartwood())`.
 * Expects: a candidate, owner or acceptor of the task (else 403);
 * a client, or null when Heartwood is not configured (503).
 * Output: `{zadanie, pisze, zamkniete, blokady[], zmiany[]}` with
 * person ids; other people's private spaces are left out.
 * Throws: 404 `NIE_ZNALEZIONO`, 403 `BRAK_DOSTEPU`, 503 `PLIKI_WYLACZONE`.
 */
export async function pliki(
  k: Kontekst, id: string | undefined, klient: IntClient | null,
): Promise<Odpowiedz> {
  const zadanie = await pobierzZadanie(k.firma, sprawdzId(id));
  if (!zadanie) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  const swoje = zadanie.kandydaci.includes(k.osoba)
    || zadanie.wlasciciel === k.osoba || zadanie.akceptujacy === k.osoba;
  if (!swoje) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  if (!klient) throw new HttpBlad(503, 'PLIKI_WYLACZONE');
  const r = await klient.getWorkFiles(k.firma, workIdOf(zadanie.id));
  const osoba = resolver(k.firma);
  const blokady = await Promise.all(r.locks.filter((l) => widoczna(l.space, k.sub)).map(async (l) => ({
    przestrzen: l.space, sciezka: l.path, folder: l.folder, kto: await osoba(l.by), kiedy: l.at,
  })));
  const zmiany = await Promise.all(r.versions.filter((v) => widoczna(v.space, k.sub)).map(async (v) => ({
    przestrzen: v.space, sciezka: v.path, seq: v.seq, rodzaj: v.kind, autor: await osoba(v.author), kiedy: v.at,
  })));
  return {
    status: 200,
    body: { zadanie: zadanie.id, pisze: await osoba(r.writer), zamkniete: r.closed, blokady, zmiany },
  };
}
