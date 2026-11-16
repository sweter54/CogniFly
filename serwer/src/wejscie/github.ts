import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CI_ONLY_EVENTS, deliverySignal } from '../dostarczenia/sygnal.js';
import { mapujGithub } from './mapuj-github.js';

const eb = new EventBridgeClient({});
const sm = new SecretsManagerClient({});
const sekrety = new Map<string, string>();

export function wyczyscCache(): void {
  sekrety.clear();
}

export function zweryfikujPodpis(cialo: string, naglowek: string | undefined, sekret: string): boolean {
  if (!naglowek || !naglowek.startsWith('sha256=')) return false;
  const oczekiwany = Buffer.from('sha256=' + createHmac('sha256', sekret).update(cialo).digest('hex'));
  const podany = Buffer.from(naglowek);
  return podany.length === oczekiwany.length && timingSafeEqual(podany, oczekiwany);
}

async function pobierzSekret(firma: string): Promise<string | undefined> {
  const w = sekrety.get(firma);
  if (w !== undefined) return w;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: `cognifly-test/github/${firma}` }));
    if (!r.SecretString) return undefined;
    sekrety.set(firma, r.SecretString);
    return r.SecretString;
  } catch (e) {
    const nazwa = e instanceof Error ? e.name : 'NieznanyBlad';
    console.warn(`github webhook: błąd Secrets Manager (${nazwa}) dla firmy ${firma}`);
    if (nazwa === 'ResourceNotFoundException') return undefined;
    throw new BladSekretu(nazwa);
  }
}

class BladSekretu extends Error {}
class BladCiala extends Error {}

interface Zadanie {
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

const odp = (statusCode: number, tresc = '') => ({ statusCode, body: tresc });

export async function handler(z: Zadanie): Promise<{ statusCode: number; body: string }> {
  const firma = z.pathParameters?.firma ?? '';
  if (!/^[a-z0-9-]{1,40}$/.test(firma)) return odp(404);

  const naglowki = Object.fromEntries(Object.entries(z.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const surowe = z.body ?? '';
  const cialo = z.isBase64Encoded ? Buffer.from(surowe, 'base64').toString('utf8') : surowe;

  let sekret: string | undefined;
  try {
    sekret = await pobierzSekret(firma);
  } catch (e) {
    if (e instanceof BladSekretu) return odp(500); // GitHub ponowi dostawę; przyczyna jest w logach
    throw e;
  }
  if (!sekret || !zweryfikujPodpis(cialo, naglowki['x-hub-signature-256'], sekret)) return odp(401);

  const idDostawy = naglowki['x-github-delivery'];
  const nazwa = naglowki['x-github-event'];
  if (!idDostawy || !nazwa) {
    console.warn('github webhook: 400, brak nagłówka x-github-delivery lub x-github-event');
    return odp(400);
  }

  // Podpis liczony jest z surowego ciała (wyżej); dopiero potem ciało jest interpretowane.
  const typTresci = (naglowki['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  let payload: unknown;
  try {
    const json = typTresci === 'application/x-www-form-urlencoded' ? new URLSearchParams(cialo).get('payload') : cialo;
    if (json === null) throw new BladCiala('brak pola payload w ciele formularza');
    payload = JSON.parse(json);
  } catch (e) {
    console.warn(`github webhook: 400, nieczytelne ciało (${typTresci || 'brak content-type'}): ${e instanceof BladCiala ? e.message : 'niepoprawny JSON'}`);
    return odp(400);
  }

  // Zdarzenia CI nie trafiają do historii ani reguł — budzą tylko nasłuch dostarczeń.
  const zdarzenie = CI_ONLY_EVENTS.includes(nazwa) ? null : mapujGithub(nazwa, idDostawy, payload, firma);
  const sygnal = deliverySignal(nazwa, payload, firma);
  const szyna = process.env.COGNIFLY_SZYNA ?? 'cognifly-test-szyna';
  const wpisy = [
    ...(zdarzenie ? [{ EventBusName: szyna, Source: 'cognifly.github', DetailType: zdarzenie.typ, Detail: JSON.stringify(zdarzenie) }] : []),
    ...(sygnal ? [{ EventBusName: szyna, Source: 'dostarczenia.github', DetailType: 'sygnal', Detail: JSON.stringify(sygnal) }] : []),
  ];
  if (!wpisy.length) return odp(202);

  const wynik = await eb.send(new PutEventsCommand({ Entries: wpisy }));
  if ((wynik.FailedEntryCount ?? 0) > 0) return odp(500);
  return odp(202);
}
