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

/**
 * Lists the not-removed `OSOBA#` records of a company.
 *
 * Call: `await activePeople(firma)`.
 * Input: a company id.
 * Output: raw items without a `usunieta` attribute; empty when none.
 */
async function activePeople(firma: string): Promise<Record<string, unknown>[]> {
  return (await wszystkie(firma, 'OSOBA#')).filter((it) => it.usunieta === undefined);
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
  const [osoby, loginy] = await Promise.all([activePeople(firma), wszystkie(firma, 'GITHUB#')]);
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
  return (await activePeople(firma))
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
  return (await activePeople(firma))
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

/** A member of the Identity service; `email` is absent in role events. */
export type Member = { sub: string; email?: string; role: 'admin' | 'member' };

const roleOf = (r: Member['role']): 'admin' | 'czlonek' => (r === 'admin' ? 'admin' : 'czlonek');
const personOf = (it: Record<string, unknown>) => (it.sk as string).slice('OSOBA#'.length);

/**
 * Derives a person id from an e-mail address.
 *
 * Call: `personIdFor('Jan.K@x.pl', new Set(['jan-k']))` -> `'jan-k-2'`.
 * Input: e-mail, ids already taken. Pure; never throws.
 * Output: lowercase local part, non `[a-z0-9]` runs -> `-`, trimmed of
 * edge dashes, max 40 chars, `osoba` when empty; `-2`, `-3`... on clash.
 */
export function personIdFor(email: string, taken: Set<string>): string {
  const local = email.split('@')[0] ?? '';
  const base = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'osoba';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** True when `at` is strictly older than the stored `tozsamoscAt`. */
const isStale = (at: string, stored: unknown): boolean =>
  typeof stored === 'string' && Date.parse(at) < Date.parse(stored);

/**
 * Drops this company's entry from a user's `PROFIL` map.
 *
 * Call: `await dropProfileEntry(sub, firma)`.
 * Input: Cognito sub and company id. A missing profile is ignored.
 * Output: nothing. Throws on other DynamoDB errors.
 */
async function dropProfileEntry(sub: string, firma: string): Promise<void> {
  try {
    await klient().send(new UpdateCommand({
      TableName: nazwaTabeli(), Key: { pk: `OSOBA#${sub}`, sk: 'PROFIL' },
      UpdateExpression: 'REMOVE firmy.#f', ConditionExpression: 'attribute_exists(firmy)',
      ExpressionAttributeNames: { '#f': firma },
    }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
  }
}

/**
 * Updates an `OSOBA#` record keeping unrelated attributes.
 *
 * Call: `patchPerson(firma, osoba, {rola: 'admin'}, ['usunieta'])`.
 * Input: attributes to set and attribute names to remove.
 * Output: nothing. Names go through placeholders (reserved words).
 */
const patchPerson = (firma: string, osoba: string, set: Record<string, unknown>, remove: string[] = []) => {
  const keys = [...Object.keys(set), ...remove];
  const sets = Object.keys(set).map((k) => `#${k} = :${k}`).join(', ');
  const expr = `SET ${sets}${remove.length ? ` REMOVE ${remove.map((k) => `#${k}`).join(', ')}` : ''}`;
  return klient().send(new UpdateCommand({
    TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: `OSOBA#${osoba}` }, UpdateExpression: expr,
    ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
    ExpressionAttributeValues: Object.fromEntries(Object.entries(set).map(([k, v]) => [`:${k}`, v])),
  })).then(() => {});
};

/**
 * Finds the person record matching a member: by sub, else by e-mail.
 *
 * Call: `findPerson(records, member)`.
 * Input: all `OSOBA#` items of a company (also removed ones), a member.
 * Output: the matching item or undefined. E-mail match ignores case.
 */
function findPerson(records: Record<string, unknown>[], m: Member): Record<string, unknown> | undefined {
  const bySub = records.find((it) => it.sub === m.sub);
  if (bySub || m.email === undefined) return bySub;
  const mail = m.email.toLowerCase();
  return records.find((it) => typeof it.email === 'string' && it.email.toLowerCase() === mail);
}

/** Writes `KONTAKT#<osoba>` with the e-mail only when no contact exists. */
async function ensureContact(firma: string, osoba: string, email: string): Promise<void> {
  if (Object.keys(await kontaktOsoby(firma, osoba)).length === 0) await zapiszKontakt(firma, osoba, { email });
}

/**
 * Copies an Identity member into the company's person registry.
 *
 * Call: `await applyMember(firma, {sub, email, role}, at)`.
 * Input: company, member (no email = role change of a known sub only),
 * ISO 8601 event time `at`.
 * Output: 'added' (new person), 'updated', or 'skipped' (older than the
 * stored `tozsamoscAt`, or unknown sub without e-mail).
 * Side effects: sets the person's sub, role, e-mail, `tozsamoscAt`,
 * clears `usunieta`, moves the `PROFIL` entry on sub change, creates a
 * missing contact. Throws on DynamoDB errors.
 */
export async function applyMember(firma: string, m: Member, at: string): Promise<'added' | 'updated' | 'skipped'> {
  const records = await wszystkie(firma, 'OSOBA#');
  const found = findPerson(records, m);
  if (!found && m.email === undefined) return 'skipped';
  if (found && isStale(at, found.tozsamoscAt)) return 'skipped';
  const osoba = found ? personOf(found) : personIdFor(m.email!, new Set(records.map(personOf)));
  const email = m.email ?? (found!.email as string);
  await patchPerson(firma, osoba, { email, rola: roleOf(m.role), sub: m.sub, tozsamoscAt: at }, ['usunieta']);
  if (typeof found?.sub === 'string' && found.sub !== m.sub) await dropProfileEntry(found.sub, firma);
  await zapiszTozsamosc(m.sub, firma, osoba);
  await ensureContact(firma, osoba, email);
  return found ? 'updated' : 'added';
}

/**
 * Marks a member as removed in the company's person registry.
 *
 * Call: `await removeMember(firma, sub, at)`.
 * Input: company, Cognito sub, ISO 8601 event time.
 * Output: 'removed', or 'skipped' for an unknown sub or an older `at`.
 * Side effects: sets `usunieta` and `tozsamoscAt` to `at`, drops the
 * company from the sub's `PROFIL`. Throws on DynamoDB errors.
 */
export async function removeMember(firma: string, sub: string, at: string): Promise<'removed' | 'skipped'> {
  const found = (await wszystkie(firma, 'OSOBA#')).find((it) => it.sub === sub);
  if (!found || isStale(at, found.tozsamoscAt)) return 'skipped';
  await patchPerson(firma, personOf(found), { usunieta: at, tozsamoscAt: at });
  await dropProfileEntry(sub, firma);
  return 'removed';
}

/**
 * Lists the subs of the active people of a company.
 *
 * Call: `await activeSubs(firma)`.
 * Input: a company id.
 * Output: sorted subs of non-removed people that have one; for
 * reconciliation with Identity.
 */
export async function activeSubs(firma: string): Promise<string[]> {
  return (await activePeople(firma)).filter((it) => typeof it.sub === 'string').map((it) => it.sub as string).sort();
}
