// Pure mapping of a CogniFly task to Heartwood's work state.
import { TASK_ID_PATTERN, type Task } from '@cognifly/wspolne/api';

/** Heartwood work state; `writer` is a CogniFly person id. */
export type WorkState = { writer: string | null; closed: boolean };

const WORK_PREFIX = 'cognifly:';

/**
 * Maps a task to the work state Heartwood should hold.
 *
 * Call: `workStateOf(task)`.
 * Expects: a task as stored by CogniFly.
 * Output: taken/in progress -> owner writes; awaiting acceptance ->
 * acceptor writes; done/rejected/deleted -> closed; new/escalated ->
 * null (no work state). A missing person gives `writer: null`.
 */
export function workStateOf(t: Task): WorkState | null {
  switch (t.stan) {
    case 'wziete':
    case 'w_trakcie':
      return { writer: t.wlasciciel ?? null, closed: false };
    case 'do_akceptacji':
      return { writer: t.akceptujacy ?? null, closed: false };
    case 'zrobione':
    case 'odrzucone':
    case 'usuniete':
      return { writer: null, closed: true };
    default:
      return null;
  }
}

/**
 * Builds the Heartwood work id of a task.
 *
 * Call: `workIdOf('zad_0123456789ab')`.
 * Expects: a task id.
 * Output: `cognifly:<id>`.
 */
export function workIdOf(taskId: string): string {
  return `${WORK_PREFIX}${taskId}`;
}

/**
 * Extracts the task id from a Heartwood work id.
 *
 * Call: `taskIdOf(workId)`.
 * Expects: any work id string.
 * Output: the task id, or null when it is not `cognifly:` + a valid
 * task id.
 */
export function taskIdOf(workId: string): string | null {
  if (!workId.startsWith(WORK_PREFIX)) return null;
  const id = workId.slice(WORK_PREFIX.length);
  return TASK_ID_PATTERN.test(id) ? id : null;
}
