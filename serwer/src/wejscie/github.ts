import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
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
  } catch {
    return undefined;
  }
}

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

  const sekret = await pobierzSekret(firma);
  if (!sekret || !zweryfikujPodpis(cialo, naglowki['x-hub-signature-256'], sekret)) return odp(401);

  const idDostawy = naglowki['x-github-delivery'];
  const nazwa = naglowki['x-github-event'];
  if (!idDostawy || !nazwa) return odp(400);

  let payload: unknown;
  try {
    payload = JSON.parse(cialo);
  } catch {
    return odp(400);
  }

  const zdarzenie = mapujGithub(nazwa, idDostawy, payload, firma);
  if (!zdarzenie) return odp(202);

  const wynik = await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: process.env.COGNIFLY_SZYNA ?? 'cognifly-test-szyna',
          Source: 'cognifly.github',
          DetailType: zdarzenie.typ,
          Detail: JSON.stringify(zdarzenie),
        },
      ],
    }),
  );
  if ((wynik.FailedEntryCount ?? 0) > 0) return odp(500);
  return odp(202);
}
