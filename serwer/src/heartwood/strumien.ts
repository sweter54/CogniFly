// Turns DynamoDB stream changes of task records into Heartwood work
// state calls (idempotent PUTs, retried per record on failure).
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import type { Task } from '@cognifly/wspolne/api';
import { intClient, type IntClient } from './klient.js';
import { workIdOf, workStateOf, type WorkState } from './praca.js';

const TASK_PK = /^FIRMA#(.+)#ZAD$/;

/** Dependencies of the stream handler. */
export type StreamDeps = {
  client: IntClient;
  subOf: (firma: string, osoba: string) => Promise<string | null>;
  log: (msg: string, ctx?: object) => void;
};

/** Lambda partial batch response. */
export type StreamResult = { batchItemFailures: { itemIdentifier: string }[] };

/**
 * Tells whether two work states are equal.
 *
 * Call: `sameWork(a, b)`.
 * Expects: work states or null.
 * Output: true when both null or writer and closed match.
 */
function sameWork(a: WorkState | null, b: WorkState | null): boolean {
  if (!a || !b) return a === b;
  return a.writer === b.writer && a.closed === b.closed;
}

/**
 * Finds the work state to send after a task change.
 *
 * Call: `changedWork(oldTask, newTask)`.
 * Expects: task images as stored (either may be missing).
 * Output: the new work state when it differs from the old one. A
 * task back in new/escalated keeps its work but loses the writer
 * (`{writer: null, closed: prev.closed}`), so a closed work stays a
 * no-op. Null when unchanged or the task was removed.
 */
export function changedWork(oldImg: Task | undefined, newImg: Task | undefined): WorkState | null {
  if (!newImg) return null;
  const prev = oldImg ? workStateOf(oldImg) : null;
  const next = workStateOf(newImg) ?? (prev && { writer: null, closed: prev.closed });
  return next && !sameWork(prev, next) ? next : null;
}

/**
 * Reads an image of a stream record as a task.
 *
 * Call: `taskImage(record.dynamodb?.NewImage)`.
 * Expects: a DynamoDB attribute map or undefined.
 * Output: the unmarshalled task, or undefined when no image.
 */
function taskImage(img: Record<string, unknown> | undefined): Task | undefined {
  return img ? (unmarshall(img as Record<string, AttributeValue>) as Task) : undefined;
}

/**
 * Resolves the Heartwood writer of a work state.
 *
 * Call: `await resolveWriter(firma, work, deps)`.
 * Expects: a work state whose writer is a CogniFly person id or null.
 * Output: the state with the writer replaced by the person's `sub`;
 * unknown sub gives a null writer and one logged warning.
 */
async function resolveWriter(firma: string, w: WorkState, d: StreamDeps): Promise<WorkState> {
  if (w.writer === null) return w;
  const sub = await d.subOf(firma, w.writer);
  if (sub === null) d.log('person has no sub, work gets no writer', { firma, osoba: w.writer });
  return { writer: sub, closed: w.closed };
}

/**
 * Sends the work state of one stream record, if it changed.
 *
 * Call: `await sendRecord(record, firma, deps)`.
 * Expects: a record of a task (`pk` = `FIRMA#<f>#ZAD`).
 * Output: resolves after the call (or none); throws on client error.
 */
async function sendRecord(r: DynamoDBRecord, firma: string, d: StreamDeps): Promise<void> {
  const task = taskImage(r.dynamodb?.NewImage);
  const work = changedWork(taskImage(r.dynamodb?.OldImage), task);
  if (!task || !work) return;
  const state = await resolveWriter(firma, work, d);
  await d.client.putWork(firma, workIdOf(task.id), state);
}

/**
 * Handles a DynamoDB stream batch.
 *
 * Call: `await handleStream(event, deps)`.
 * Expects: stream records of the CogniFly table (any item type).
 * Output: partial batch response; a record whose call failed is
 * listed by `eventID` so that it is retried. Non-task records skip.
 */
export async function handleStream(event: DynamoDBStreamEvent, d: StreamDeps): Promise<StreamResult> {
  const failures: { itemIdentifier: string }[] = [];
  for (const r of event.Records) {
    const pk = r.dynamodb?.Keys?.pk?.S ?? r.dynamodb?.NewImage?.pk?.S ?? r.dynamodb?.OldImage?.pk?.S;
    const firma = pk ? TASK_PK.exec(pk)?.[1] : undefined;
    if (!firma) continue;
    try {
      await sendRecord(r, firma, d);
    } catch (e) {
      d.log('work state call failed', { firma, error: String(e) });
      failures.push({ itemIdentifier: r.eventID ?? '' });
    }
  }
  return { batchItemFailures: failures };
}

/**
 * Lambda entry point (DynamoDB stream event source).
 *
 * Call: configured as handler; reads `HEARTWOOD_INT_URL`, `AWS_REGION`.
 * Expects: stream view with old and new images.
 * Output: partial batch response (see `handleStream`).
 */
export async function handler(event: DynamoDBStreamEvent): Promise<StreamResult> {
  const { subOsoby } = await import('../dane/konfiguracja.js');
  const client = intClient({ url: process.env.HEARTWOOD_INT_URL!, region: process.env.AWS_REGION! });
  return handleStream(event, {
    client, subOf: subOsoby, log: (m, c) => console.warn(m, c),
  });
}
