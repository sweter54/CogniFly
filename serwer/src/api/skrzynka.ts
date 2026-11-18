import { skrzynka as pobierz } from '../dane/kolejka.js';
import { watkiOsoby } from '../dane/watki.js';
import { RETURNED_STATES, WAITING_STATES } from '@cognifly/wspolne/api';
import type { Kontekst, Odpowiedz } from './kontekst.js';

export async function skrzynkaOsoby(k: Kontekst): Promise<Odpowiedz> {
  const [zadania, watki] = await Promise.all([pobierz(k.firma, k.osoba), watkiOsoby(k.firma, k.osoba)]);
  return { status: 200, body: { zadania: zadania.map((z) => (watki.has(z.id) ? { ...z, watek: watki.get(z.id) } : z)) } };
}

/** Zadania czekające na osobę: do wzięcia albo odrzucone (decyzja nadawcy). */
const ISTOTNE = [...WAITING_STATES, ...RETURNED_STATES];


/** Polska liczba mnoga: 1 zadanie, 2-4 zadania (nie 12-14), reszta zadań. */
export function formaZadan(n: number): string {
  if (n === 1) return 'zadanie';
  const j = n % 10, d = n % 100;
  return j >= 2 && j <= 4 && !(d >= 12 && d <= 14) ? 'zadania' : 'zadań';
}

const porzadek = (s: string) => s.replace(/\s+/g, ' ').trim(); // \s obejmuje CR/LF i U+2028/2029

function przytnij(s: string, maks: number): string {
  if (s.length <= maks) return s;
  const znaki = Array.from(s);
  while (znaki.length && znaki.join('').length + 1 > maks) znaki.pop();
  return `${znaki.join('').trimEnd()}…`;
}

/**
 * Jednolinijkowe podsumowanie dla hooka SessionStart. Liczy zadania OCZEKUJĄCE na osobę (stan nowe/eskalowane,
 * osoba jest kandydatem); wzięte/w trakcie nie są „czekające”. Treść wyłącznie z `opis`. Maks. 160 znaków.
 */
export function liniaPodsumowania(opisy: string[]): string {
  const n = opisy.length;
  if (n === 0) return '';
  const glowa = `CogniFly: ${n} ${formaZadan(n)} ${formaZadan(n) === 'zadania' ? 'czekają' : 'czeka'}`;
  const czyste = opisy.map(porzadek).filter((o) => o !== '');
  if (czyste.length === 0) return przytnij(glowa, 160);
  const lista = czyste.slice(0, 3).join(', ') + (czyste.length > 3 ? `, +${czyste.length - 3}` : '');
  const miejsce = 160 - glowa.length - 3;
  if (miejsce < 2) return przytnij(glowa, 160);
  return `${glowa} (${przytnij(lista, miejsce)})`;
}

export async function podsumowanie(k: Kontekst): Promise<Odpowiedz> {
  const wszystkie = await pobierz(k.firma, k.osoba, [...ISTOTNE, 'do_akceptacji']);
  const czekajace = wszystkie.filter((z) => z.stan !== 'do_akceptacji' || z.akceptujacy === k.osoba);
  return { status: 200, body: { linia: liniaPodsumowania(czekajace.map((z) => z.opis)) } };
}
