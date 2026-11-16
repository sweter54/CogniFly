import type { Kanal } from '@cognifly/wspolne';
import { oznaczEskalowane, pobierzZadanie } from '../dane/kolejka.js';
import { wyslijPowiadomienia } from '../powiadomienia/wyslij.js';

/**
 * Rekord EVT przechowuje tylko znacznik idempotencji, więc treść bierzemy z zadania (`opis` zbudowany przez serwer).
 * Bramka `oznaczEskalowane` (warunek stan = nowe) rozstrzyga wyścig z „biorę”: po przegranej nic nie wysyłamy.
 */
export async function obsluzEskalacje(
  wej: { firma: string; zadanieId: string },
  wyslij: typeof wyslijPowiadomienia = wyslijPowiadomienia,
): Promise<'ESKALOWANE' | 'POMINIETE'> {
  const zadanie = await pobierzZadanie(wej.firma, wej.zadanieId);
  if (!zadanie) return 'POMINIETE';
  if (!(await oznaczEskalowane(wej.firma, wej.zadanieId))) return 'POMINIETE';

  const kanaly: Kanal[] = ['email', 'discord'];
  const odbiorcy = zadanie.eskalujDo?.length
    ? zadanie.eskalujDo
    : zadanie.kandydaci.map((osoba) => ({ osoba, kanaly }));
  try {
    const w = await wyslij(wej.firma, { opis: zadanie.opis }, odbiorcy, 'eskalacja');
    if (w.bledy.length) console.error('eskalacja: błędy powiadomień', { firma: wej.firma, zadanie: wej.zadanieId, bledy: w.bledy });
  } catch (e) {
    console.error('eskalacja: wyjątek powiadomień', { firma: wej.firma, zadanie: wej.zadanieId, blad: String(e) });
  }
  return 'ESKALOWANE';
}

/** Handler Lambdy wywoływanej przez jednorazowy budzik Schedulera (Input: {firma, zadanieId}). */
export async function handler(event: { firma: string; zadanieId: string }): Promise<void> {
  const e = event as unknown;
  if (
    typeof e !== 'object' || e === null ||
    typeof (e as Record<string, unknown>).firma !== 'string' || !(e as { firma: string }).firma ||
    typeof (e as Record<string, unknown>).zadanieId !== 'string' || !(e as { zadanieId: string }).zadanieId
  ) {
    console.error('eskalacja: niepoprawne wejście, pomijam');
    return;
  }
  const { firma, zadanieId } = e as { firma: string; zadanieId: string };
  const wynik = await obsluzEskalacje({ firma, zadanieId });
  console.log('eskalacja', { firma, zadanieId, wynik });
}
