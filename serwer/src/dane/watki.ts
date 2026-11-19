// Claude Desktop threads a person used for tasks: one record per
// person and task, read only for that person's own inbox.
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { klient, nazwaTabeli } from './tabela.js';

const pkWatki = (firma: string, osoba: string) => `FIRMA#${firma}#WATEK#${osoba}`;
/** Records are dropped after 90 days without a new write. */
const ZYCIE_S = 90 * 24 * 3600;

/**
 * Remembers the thread a person works on a task in.
 *
 * Call: `await zapiszWatek(firma, osoba, idZadania, watek)`.
 * Expects: a validated task id and thread id.
 * Output: none; a later write replaces the earlier thread.
 */
export async function zapiszWatek(firma: string, osoba: string, idZadania: string, watek: string): Promise<void> {
  await klient().send(new PutCommand({
    TableName: nazwaTabeli(),
    Item: { pk: pkWatki(firma, osoba), sk: idZadania, watek, wygasa: Math.floor(Date.now() / 1000) + ZYCIE_S },
  }));
}

/**
 * Threads of one person.
 *
 * Call: `await watkiOsoby(firma, osoba)`.
 * Expects: company and person ids.
 * Output: map task id → thread id.
 */
export async function watkiOsoby(firma: string, osoba: string): Promise<Map<string, string>> {
  const wynik = new Map<string, string>();
  let start: Record<string, unknown> | undefined;
  do {
    const r = await klient().send(new QueryCommand({
      TableName: nazwaTabeli(), KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pkWatki(firma, osoba) }, ExclusiveStartKey: start,
    }));
    for (const it of r.Items ?? []) wynik.set(it.sk as string, it.watek as string);
    start = r.LastEvaluatedKey;
  } while (start);
  return wynik;
}
