import { PutCommand, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Regula } from '@cognifly/wspolne';
import { klient, nazwaTabeli } from './tabela.js';

/*
 * Konfiguracja firmy: pk=FIRMA#<f>#KONF, sk:
 *   REGULA#<id>      -> { regula }
 *   ROLA#<nazwa>     -> { osoby: string[] }
 *   KONTAKT#<osoba>  -> { email?, discordWebhookRef? }
 *   OSOBA#<osoba>    -> { email, rola: 'admin' | 'czlonek', sub? }
 *   GITHUB#<login>   -> { osoba }   (login małymi literami)
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

export const zapiszOsobe = (
  firma: string, osoba: string, o: { email: string; rola: 'admin' | 'czlonek'; sub?: string },
) => wstaw(firma, `OSOBA#${osoba}`, { ...o });

/** Identyfikator `sub` osoby (użytkownik Cognito) albo null, gdy brak. */
export async function subOsoby(firma: string, osoba: string): Promise<string | null> {
  const r = await klient().send(
    new GetCommand({ TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: `OSOBA#${osoba}` }, ConsistentRead: true }),
  );
  return typeof r.Item?.sub === 'string' ? r.Item.sub : null;
}

/** Członkowie firmy z loginem GitHub (jeśli powiązany), posortowani po id; bez e-maili. */
export async function osobyFirmy(firma: string): Promise<{ osoba: string; github?: string }[]> {
  const [osoby, loginy] = await Promise.all([wszystkie(firma, 'OSOBA#'), wszystkie(firma, 'GITHUB#')]);
  const login = new Map(loginy.map((it) => [it.osoba as string, (it.sk as string).slice('GITHUB#'.length)]));
  return osoby
    .map((it) => (it.sk as string).slice('OSOBA#'.length))
    .sort()
    .map((osoba) => (login.has(osoba) ? { osoba, github: login.get(osoba)! } : { osoba }));
}

/**
 * Lists the full person records of a company.
 *
 * Call: `await rejestrOsob(firma)`.
 * Expects: a company id.
 * Output: `{osoba, email, rola, sub?}` per `OSOBA#` record, sorted by
 * person id; empty when none.
 */
export async function rejestrOsob(
  firma: string,
): Promise<{ osoba: string; email: string; rola: 'admin' | 'czlonek'; sub?: string }[]> {
  return (await wszystkie(firma, 'OSOBA#'))
    .map((it) => ({
      osoba: (it.sk as string).slice('OSOBA#'.length),
      email: it.email as string,
      rola: it.rola as 'admin' | 'czlonek',
      ...(typeof it.sub === 'string' ? { sub: it.sub } : {}),
    }))
    .sort((a, b) => a.osoba.localeCompare(b.osoba));
}

/**
 * Lists the admins of a company.
 *
 * Call: `await adminiFirmy(firma)`.
 * Expects: a company id.
 * Output: person ids of `OSOBA#` records with `rola: 'admin'`, sorted;
 * empty when none.
 */
export async function adminiFirmy(firma: string): Promise<string[]> {
  return (await wszystkie(firma, 'OSOBA#'))
    .filter((it) => it.rola === 'admin')
    .map((it) => (it.sk as string).slice('OSOBA#'.length))
    .sort();
}

/** Login GitHub (także konta botów `nazwa[bot]`). */
export const LOGIN_GITHUB = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

/** Powiązanie loginu GitHub z osobą w firmie (ustawia admin, np. skrypt zasiewu). */
export const zapiszLoginGithub = (firma: string, login: string, osoba: string) =>
  wstaw(firma, `GITHUB#${login.toLowerCase()}`, { osoba });

/** Osoba CogniFly o danym loginie GitHub albo null. */
export async function osobaPoLoginie(firma: string, login: string): Promise<string | null> {
  if (!LOGIN_GITHUB.test(login)) return null;
  const r = await klient().send(
    new GetCommand({ TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: `GITHUB#${login.toLowerCase()}` }, ConsistentRead: true }),
  );
  return typeof r.Item?.osoba === 'string' ? r.Item.osoba : null;
}

/*
 * Tożsamość (indeks per użytkownik, celowo NIE w przestrzeni firmy): pk=OSOBA#<sub>, sk=PROFIL,
 * firmy: { [firma]: osobaId }. Po rozwiązaniu firmy wszystko dalej jest firmowe.
 */
export async function zapiszTozsamosc(sub: string, firma: string, osobaId: string): Promise<void> {
  const Key = { pk: `OSOBA#${sub}`, sk: 'PROFIL' };
  const T = nazwaTabeli();
  await klient().send(new UpdateCommand({
    TableName: T, Key, UpdateExpression: 'SET firmy = if_not_exists(firmy, :pusta)', ExpressionAttributeValues: { ':pusta': {} },
  }));
  await klient().send(new UpdateCommand({
    TableName: T, Key, UpdateExpression: 'SET firmy.#f = :o',
    ExpressionAttributeNames: { '#f': firma }, ExpressionAttributeValues: { ':o': osobaId },
  }));
}

/** Mapa firma -> osobaId użytkownika o danym `sub`; null gdy brak profilu. */
export async function tozsamosc(sub: string): Promise<Record<string, string> | null> {
  const r = await klient().send(
    new GetCommand({ TableName: nazwaTabeli(), Key: { pk: `OSOBA#${sub}`, sk: 'PROFIL' }, ConsistentRead: true }),
  );
  return r.Item ? ((r.Item.firmy as Record<string, string> | undefined) ?? {}) : null;
}
