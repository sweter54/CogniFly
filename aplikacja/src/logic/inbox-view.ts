// Pure presentation rules of the inbox list (no DOM): order of tasks
// and which state the "change state" select shows.
import { USER_SETTABLE_STATES, WAITING_STATES, type Task } from '@cognifly/wspolne/api';

/** States after which nothing more is expected from the owner. */
const FINISHED_STATES: readonly string[] = ['zrobione', 'usuniete'];
/** States in which nothing can be rejected any more. */
const CLOSED_STATES: readonly string[] = [...FINISHED_STATES, 'odrzucone'];

/**
 * Tells whether a task is finished.
 *
 * Call: `isFinished(task)`.
 * Expects: a task.
 * Output: true for `zrobione` and `usuniete`.
 */
export function isFinished(task: Task): boolean {
  return FINISHED_STATES.includes(task.stan);
}

/**
 * Orders tasks for display: open ones first, finished ones last.
 *
 * Call: `displayOrder(tasks)`.
 * Expects: tasks from `/skrzynka` (already ordered by the server).
 * Output: a new array; the server order is kept inside each group.
 */
export function displayOrder(tasks: readonly Task[]): Task[] {
  return [...tasks.filter((t) => !isFinished(t)), ...tasks.filter(isFinished)];
}

/**
 * Value the "change state" select should show for a task.
 *
 * Call: `selectValue(task)`.
 * Expects: a task.
 * Output: its state when the user can set it (`w_trakcie`,
 * `do_akceptacji`, `zrobione`), otherwise `''` (the placeholder).
 */
export function selectValue(task: Task): string {
  return (USER_SETTABLE_STATES as readonly string[]).includes(task.stan) ? task.stan : '';
}

/**
 * Tells whether the user may reject a task back to its sender.
 *
 * Call: `canReject(task, me)`.
 * Expects: a task and the user's person id (null when unknown).
 * Output: true when the task has a sender, is not closed, and the
 * user owns it or is a candidate while nobody has taken it.
 */
export function canReject(task: Task, me: string | null): boolean {
  if (!me || !task.nadawca || CLOSED_STATES.includes(task.stan)) return false;
  if (task.wlasciciel) return task.wlasciciel === me;
  return (WAITING_STATES as readonly string[]).includes(task.stan) && task.kandydaci.includes(me);
}

/**
 * One-line description of a rejection.
 *
 * Call: `rejectionText(task)`.
 * Expects: a task (the reason is a person's free text: shown as
 * quoted data, never interpreted).
 * Output: `Odrzucone przez <osoba>: „<powód>”`, or `''`.
 */
export function rejectionText(task: Task): string {
  const r = task.odrzucenie;
  if (!r) return '';
  const reason = r.powod.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  return `Odrzucone przez ${r.osoba}: „${reason}”`;
}
