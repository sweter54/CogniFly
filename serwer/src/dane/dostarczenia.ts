// Delivery watches: accepted PRs the server keeps assessing until they
// are delivered. pk=FIRMA#<f>#DOST, sk=<repo lowercase>#<pr>. A tiny
// registry (pk=REJESTR#DOSTARCZENIA, sk=<firma>) lists companies with
// watches for the periodic sweep; it holds company ids only.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { klient, nazwaTabeli } from './tabela.js';

/** One watched delivery. */
export interface Watch {
  firma: string;
  repo: string;
  pr: number;
  /** CR task that accepted the PR. */
  reviewTaskId: string;
  /** Person (CogniFly id) who accepted it. */
  reviewer: string;
  acceptedSha: string;
  acceptedAt: string;
  status: 'waiting' | 'ready' | 'delivered';
  reasons: string[];
  deliveryTaskId?: string;
  checkedAt?: string;
}

const pk = (firma: string) => `FIRMA#${firma}#DOST`;
const REGISTRY = 'REJESTR#DOSTARCZENIA';

/**
 * Sort key of a watch.
 *
 * Call: `watchKey('O/R', 12)`.
 * Expects: `owner/name` and a PR number.
 * Output: `o/r#12`.
 */
export function watchKey(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

/**
 * Creates or replaces a watch (a new acceptance restarts it).
 *
 * Call: `await saveWatch(watch)`.
 * Expects: a complete watch.
 * Output: none; the company is added to the registry.
 */
export async function saveWatch(w: Watch): Promise<void> {
  const T = nazwaTabeli();
  await klient().send(new PutCommand({ TableName: T, Item: { pk: pk(w.firma), sk: watchKey(w.repo, w.pr), ...w } }));
  await klient().send(new PutCommand({ TableName: T, Item: { pk: REGISTRY, sk: w.firma } }));
}

/**
 * All watches of a company.
 *
 * Call: `await watchesOf(firma)`.
 * Expects: a company id.
 * Output: the watches (any status).
 */
export async function watchesOf(firma: string): Promise<Watch[]> {
  const out: Watch[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await klient().send(new QueryCommand({
      TableName: nazwaTabeli(), KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk(firma) }, ConsistentRead: true, ExclusiveStartKey: start,
    }));
    for (const it of r.Items ?? []) {
      const { pk: _pk, sk: _sk, ...w } = it;
      out.push(w as Watch);
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/**
 * One watch, if it exists.
 *
 * Call: `await watchOf(firma, repo, pr)`.
 * Expects: a company and a PR.
 * Output: the watch or null.
 */
export async function watchOf(firma: string, repo: string, pr: number): Promise<Watch | null> {
  const r = await klient().send(new GetCommand({ TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: watchKey(repo, pr) }, ConsistentRead: true }));
  if (!r.Item) return null;
  const { pk: _pk, sk: _sk, ...w } = r.Item;
  return w as Watch;
}

/**
 * Records the latest assessment of a watch.
 *
 * Call: `await updateWatch(firma, repo, pr, { status, reasons, ... })`.
 * Expects: an existing watch.
 * Output: none.
 */
export async function updateWatch(
  firma: string, repo: string, pr: number, patch: Pick<Watch, 'status' | 'reasons' | 'checkedAt'> & { deliveryTaskId?: string },
): Promise<void> {
  const names: Record<string, string> = { '#s': 'status', '#r': 'reasons', '#c': 'checkedAt' };
  const values: Record<string, unknown> = { ':s': patch.status, ':r': patch.reasons, ':c': patch.checkedAt };
  let set = '#s = :s, #r = :r, #c = :c';
  if (patch.deliveryTaskId) {
    names['#d'] = 'deliveryTaskId';
    values[':d'] = patch.deliveryTaskId;
    set += ', #d = :d';
  }
  await klient().send(new UpdateCommand({
    TableName: nazwaTabeli(), Key: { pk: pk(firma), sk: watchKey(repo, pr) },
    UpdateExpression: `SET ${set}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

/**
 * Companies that have watches (for the periodic sweep).
 *
 * Call: `await companiesWithWatches()`.
 * Expects: nothing.
 * Output: company ids.
 */
export async function companiesWithWatches(): Promise<string[]> {
  const r = await klient().send(new QueryCommand({
    TableName: nazwaTabeli(), KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': REGISTRY },
  }));
  return (r.Items ?? []).map((it) => it.sk as string);
}
