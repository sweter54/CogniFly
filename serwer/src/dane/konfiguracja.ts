import { PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Regula } from '@cognifly/wspolne';
import { klient, nazwaTabeli } from './tabela.js';

/*
 * Konfiguracja firmy: pk=FIRMA#<f>#KONF, sk:
 *   REGULA#<id>      -> { regula }
 *   ROLA#<nazwa>     -> { osoby: string[] }
 *   KONTAKT#<osoba>  -> { email?, discordWebhookRef? }
 *   OSOBA#<osoba>    -> { email, rola: 'admin' | 'czlonek' }
 */
const pk = (firma: string) => `FIRMA#${firma}#KONF`;

async function wszystkie(firma: string, prefiks: string): Promise<Record<string, unknown>[]> {
  const wynik: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await klient().send(
      new QueryCommand({
        TableName: nazwaTabeli(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': pk(firma), ':p': prefiks },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    wynik.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return wynik;
}

export async function regulyFirmy(firma: string): Promise<Regula[]> {
  return (await wszystkie(firma, 'REGULA#')).map((it) => it.regula as Regula);
}

/** Zwykły obiekt (nazwa roli -> osoby). Silnik sprawdza klucze przez Object.hasOwn. */
export async function roleFirmy(firma: string): Promise<Record<string, string[]>> {
  return Object.fromEntries(
    (await wszystkie(firma, 'ROLA#')).map((it) => [(it.sk as string).slice('ROLA#'.length), it.osoby as string[]]),
  );
}

export async function kontaktOsoby(firma: string, osoba: string): Promise<{ email?: string; discordWebhookRef?: string }> {
  const r = await klient().send(
    new GetCommand({ TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: `KONTAKT#${osoba}` }, ConsistentRead: true }),
  );
  if (!r.Item) return {};
  const { email, discordWebhookRef } = r.Item as { email?: string; discordWebhookRef?: string };
  return { ...(email !== undefined ? { email } : {}), ...(discordWebhookRef !== undefined ? { discordWebhookRef } : {}) };
}

const wstaw = (firma: string, sk: string, reszta: Record<string, unknown>) =>
  klient().send(new PutCommand({ TableName: nazwaTabeli(), Item: { pk: pk(firma), sk, ...reszta } })).then(() => {});

export async function zapiszRegule(r: Regula): Promise<void> {
  if (r.eskalacjaMin !== undefined && !(Number.isInteger(r.eskalacjaMin) && r.eskalacjaMin >= 1 && r.eskalacjaMin <= 10080)) {
    throw new Error(`eskalacjaMin musi być liczbą całkowitą 1..10080 (reguła ${r.id})`);
  }
  await wstaw(r.firma, `REGULA#${r.id}`, { regula: r });
}

export const zapiszRole = (firma: string, nazwa: string, osoby: string[]) => wstaw(firma, `ROLA#${nazwa}`, { osoby });

export const zapiszKontakt = (firma: string, osoba: string, k: { email?: string; discordWebhookRef?: string }) =>
  wstaw(firma, `KONTAKT#${osoba}`, { ...k });

export const zapiszOsobe = (firma: string, osoba: string, o: { email: string; rola: 'admin' | 'czlonek' }) =>
  wstaw(firma, `OSOBA#${osoba}`, { ...o });
