// Pure presentation rules of the inbox list (no DOM): order of tasks
// and which state the "change state" select shows.
import { USER_SETTABLE_STATES, type Task } from '@cognifly/wspolne/api';

/** States after which nothing more is expected from the owner. */
const FINISHED_STATES: readonly string[] = ['zrobione'];

/**
 * Tells whether a task is finished.
 *
 * Call: `isFinished(task)`.
 * Expects: a task.
 * Output: true for `zrobione`.
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
