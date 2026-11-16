// Inbox window: the user's tasks with "biorę" and state changes.
// Task text is inserted with textContent only (it is data).
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import { INBOX_EVENT, type InboxView } from './protocol.js';
import { tauriBus } from './tauri-bus.js';
import { byId, connect, messageFor, setStatus, type Call } from './ui.js';

/** Outcome message of a user action. */
type Outcome = { text: string; kind: 'ok' | 'error' };

/** Polish names of task states. */
const STATE_NAMES: Record<string, string> = {
  nowe: 'nowe', eskalowane: 'eskalowane', wziete: 'wzięte', w_trakcie: 'w trakcie',
  do_akceptacji: 'do akceptacji', zrobione: 'zrobione',
};

/**
 * Renders the whole view.
 *
 * Call: `render(call, view)` on load, refresh and pushed updates.
 * Expects: inbox.html markup.
 * Output: none; replaces the list and the status line.
 */
function render(call: Call, view: InboxView): void {
  const list = byId<HTMLUListElement>('list');
  list.replaceChildren(...view.tasks.map((t) => taskItem(call, t, view.email)));
  setStatus(statusText(view), view.offline ? 'error' : 'info');
}

/**
 * Status line for a view.
 *
 * Call: `statusText(view)`.
 * Expects: a view.
 * Output: Polish text: logged out, offline, empty or last update.
 */
function statusText(view: InboxView): string {
  if (!view.loggedIn) return 'Niezalogowano — użyj menu CogniFly przy zegarze, aby się zalogować.';
  if (view.offline) return 'Brak połączenia — pokazuję ostatnio pobrane zadania.';
  if (view.tasks.length === 0) return 'Brak zadań.';
  return view.updatedAt ? `Zaktualizowano ${new Date(view.updatedAt).toLocaleTimeString('pl-PL')}.` : '';
}

/**
 * Builds one list item from the template.
 *
 * Call: `taskItem(call, task, email)`.
 * Expects: a `#task-template` element.
 * Output: the `<li>`; "biorę" only for waiting tasks, state change
 * only for tasks the user owns.
 */
function taskItem(call: Call, task: Task, email: string | null): HTMLLIElement {
  const tpl = byId<HTMLTemplateElement>('task-template');
  const li = (tpl.content.firstElementChild as HTMLLIElement).cloneNode(true) as HTMLLIElement;
  li.dataset.state = task.stan;
  (li.querySelector('.desc') as HTMLElement).textContent = task.opis;
  (li.querySelector('.meta') as HTMLElement).textContent = metaText(task);
  const take = li.querySelector('.take') as HTMLButtonElement;
  const state = li.querySelector('.state') as HTMLSelectElement;
  take.hidden = task.stan !== 'nowe' && task.stan !== 'eskalowane';
  state.hidden = !task.wlasciciel || !email;
  take.addEventListener('click', () => void act(call, () => takeTask(call, task.id)));
  state.addEventListener('change', () => {
    if (state.value) void act(call, () => changeState(call, task.id, state.value as UserSettableState));
  });
  return li;
}

/**
 * Secondary line of a task.
 *
 * Call: `metaText(task)`.
 * Expects: a task.
 * Output: state, owner and creation time in Polish.
 */
function metaText(task: Task): string {
  const parts = [`Stan: ${STATE_NAMES[task.stan] ?? task.stan}`];
  if (task.wlasciciel) parts.push(`osoba: ${task.wlasciciel}`);
  const created = new Date(task.utworzono);
  if (!Number.isNaN(created.getTime())) parts.push(created.toLocaleString('pl-PL'));
  return parts.join(' · ');
}

/**
 * Takes a task.
 *
 * Call: `await takeTask(call, id)`.
 * Expects: a waiting task id.
 * Output: the message to show; BUSY names who already took it.
 */
async function takeTask(call: Call, id: string): Promise<Outcome> {
  const r = await call('inbox.take', { id });
  if (r.status === 'BUSY') return { text: `To zadanie jest już zajęte przez: ${r.owner}.`, kind: 'error' };
  return { text: 'Zadanie jest Twoje.', kind: 'ok' };
}

/**
 * Changes the state of an owned task.
 *
 * Call: `await changeState(call, id, state)`.
 * Expects: a state from the select.
 * Output: the confirmation message.
 */
async function changeState(call: Call, id: string, state: UserSettableState): Promise<Outcome> {
  await call('inbox.setState', { id, state });
  return { text: `Zmieniono stan na: ${STATE_NAMES[state]}.`, kind: 'ok' };
}

/**
 * Runs an action, reloads the list, then shows the outcome.
 *
 * Call: `await act(call, action)`.
 * Expects: an action that may throw rpc errors.
 * Output: none; errors become Polish messages.
 */
async function act(call: Call, action: () => Promise<Outcome>): Promise<void> {
  try {
    const outcome = await action();
    render(call, await call('inbox.refresh', {}));
    setStatus(outcome.text, outcome.kind);
  } catch (e) {
    setStatus(messageFor(e), 'error');
  }
}

/**
 * Window entry.
 *
 * Call: once at module load.
 * Expects: inbox.html markup.
 * Output: none; listens for pushed views and loads the current one.
 */
async function main(): Promise<void> {
  const call = await connect();
  await tauriBus().listen(INBOX_EVENT, (view) => render(call, view as InboxView));
  byId('refresh').addEventListener('click', () => void call('inbox.refresh', {}).then((v) => render(call, v)).catch((e) => setStatus(messageFor(e), 'error')));
  render(call, await call('inbox.get', {}));
}

main().catch((e) => setStatus(messageFor(e), 'error'));
