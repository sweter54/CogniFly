import { ConflictException, CreateScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { zwalidujZdarzenie, type Kanal, type Zdarzenie } from '@cognifly/wspolne';
import { zapiszZdarzenie } from '../dane/historia.js';
import { regulyFirmy, roleFirmy } from '../dane/konfiguracja.js';
import { pobierzZadanie, utworzZadanie } from '../dane/kolejka.js';
import { rozstrzygnij } from '../reguly/silnik.js';

export type WyslijPowiadomienia = (
  firma: string,
  z: Zdarzenie,
  odbiorcy: { osoba: string; kanaly: Kanal[] }[],
  rodzaj: 'nowe' | 'eskalacja',
) => Promise<{ wyslane: number; bledy: string[] }>;

export interface Zaleznosci {
  scheduler: Pick<SchedulerClient, 'send'>;
  wyslijPowiadomienia: WyslijPowiadomienia;
  teraz: () => Date;
}

export interface Wynik { wynik: 'DUPLIKAT' | 'ZAPISANE'; zadanieId?: string }

const MIN_OPOZNIENIE_MS = 60_000;

/** `at()` przyjmuje UTC bez ms i bez Z. */
const atWyrazenie = (d: Date) => `at(${d.toISOString().slice(0, 19)})`;

/**
 * Idempotencja i retry (EventBridge ponawia przy wyjątku):
 *  - id zadania wynika z id zdarzenia (`zad_` + 24 hex), a tworzenie zadania i budzika jest idempotentne
 *    (warunkowy put zwracający istniejące; ConflictException z Schedulera = sukces).
 *  - DUPLIKAT oznacza, że zapis już był, ale poprzedni przebieg mógł paść po zapisie, a przed zadaniem/budzikiem.
 *    Gdy reguły dają zadanie, domykamy brakujące kroki (zadanie, budzik), ale NIE wysyłamy powiadomień
 *    (mogły już pójść; wysłanie ich ponownie jest gorsze niż możliwe pominięcie przy awarii między krokami).
 *  - Budzik domykany tylko, gdy zadanie nadal w stanie `nowe` (inaczej eskalacja jest już zbędna lub wykonana).
 *  - Błąd powiadomień jest logowany i nie przerywa przetwarzania (zadanie istnieje, ponowienie nic by nie dało).
 */
export async function obsluzZdarzenie(z: Zdarzenie, zal: Zaleznosci): Promise<Wynik> {
  const zapis = await zapiszZdarzenie(z);
  const nowe = zapis === 'NOWE';

  const [reguly, role] = await Promise.all([regulyFirmy(z.firma), roleFirmy(z.firma)]);
  const decyzja = rozstrzygnij(z, reguly, role);

  let zadanieId: string | undefined;
  if (decyzja.kandydaci.length > 0) {
    const id = `zad_${z.id.slice('evt_'.length)}`;
    const istnialo = nowe ? null : await pobierzZadanie(z.firma, id);
    const zadanie = istnialo ?? await utworzZadanie(z.firma, z.id, decyzja.kandydaci, {
      id, opis: z.opis, ...(decyzja.eskalujDo.length ? { eskalujDo: decyzja.eskalujDo } : {}),
    });
    zadanieId = zadanie.id;

    if (nowe || zadanie.stan === 'nowe') {
      const minuty = decyzja.eskalacjaMin ?? 15;
      const teraz = zal.teraz();
      const o = nowe || !istnialo
        ? new Date(teraz.getTime() + minuty * 60_000)
        : new Date(Math.max(Date.parse(zadanie.utworzono) + minuty * 60_000, teraz.getTime() + MIN_OPOZNIENIE_MS));
      await utworzBudzik(zal.scheduler, z.firma, zadanie.id, o);
    }
  }

  if (!nowe) return { wynik: 'DUPLIKAT', ...(zadanieId ? { zadanieId } : {}) };

  if (decyzja.powiadom.length > 0) {
    try {
      const w = await zal.wyslijPowiadomienia(z.firma, z, decyzja.powiadom, 'nowe');
      if (w.bledy.length) console.error('powiadomienia: błędy', { firma: z.firma, zdarzenie: z.id, bledy: w.bledy });
    } catch (e) {
      console.error('powiadomienia: wyjątek', { firma: z.firma, zdarzenie: z.id, blad: String(e) });
    }
  }
  return { wynik: 'ZAPISANE', ...(zadanieId ? { zadanieId } : {}) };
}

async function utworzBudzik(scheduler: Zaleznosci['scheduler'], firma: string, zadanieId: string, kiedy: Date): Promise<void> {
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: `cognifly-test-esk-${zadanieId}`,
        ScheduleExpression: atWyrazenie(kiedy),
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: process.env.COGNIFLY_ESKALACJA_ARN!,
          RoleArn: process.env.COGNIFLY_SCHEDULER_ROLA_ARN!,
          Input: JSON.stringify({ firma, zadanieId }),
        },
      }),
    );
  } catch (e) {
    if (e instanceof ConflictException) return; // retry tego samego zdarzenia: budzik już istnieje
    throw e;
  }
}

let scheduler: SchedulerClient | undefined;

/** Handler targetu reguły EventBridge (source z prefiksem `cognifly.`). */
export async function handler(event: { detail: unknown; source: string }): Promise<void> {
  const w = zwalidujZdarzenie(event.detail);
  if (!w.ok) {
    console.error('niepoprawne zdarzenie, pomijam', { source: event.source, blad: w.blad });
    return;
  }
  scheduler ??= new SchedulerClient({});
  await obsluzZdarzenie(w.zdarzenie, {
    scheduler,
    teraz: () => new Date(),
    wyslijPowiadomienia: async (...a) => (await import('../powiadomienia/wyslij.js')).wyslijPowiadomienia(...a),
  });
}
