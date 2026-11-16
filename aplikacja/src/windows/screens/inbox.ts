// Inbox screen: the user's tasks with "biorę" and state changes.
// Task text is inserted with textContent only (it is data).
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { InboxView } from '../protocol.js';
import { byId, messageFor, setStatus, type Call } from '../ui.js';

/** Polish names of task states. */
const STATE_NAMES: Record<string, string> = {
  nowe: 'nowe', eskalowane: 'eskalowane', wziete: 'wzięte', w_trakcie: 'w trakcie',
  do_akceptacji: 'do akceptacji', zrobione: 'zrobione',
};

/** Outcome message of a user action. */
type Outcome = { text: string; kind: 'ok' | 'error' };

/** Handle returned by `mountInbox`. */
export interface InboxScreen { render(view: InboxView): void }

/**
 * Status line for a view.
 *
 * Call: `statusText(view)`.
 * Expects: a view.
 * Output: Polish text: offline, empty or last update time.
 */
function statusText(view: InboxView): string {
  if (view.offline) return 'Brak połączenia — pokazuję ostatnio pobrane zadania.';
  if (view.tasks.length === 0) return 'Brak zadań. Powiadomimy Cię, gdy coś się pojawi.';
  return view.updatedAt ? `Zaktualizowano ${new Date(view.updatedAt).toLocaleTimeString('pl-PL')}.` : '';
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
 * Wires the inbox screen.
 *
 * Call: `mountInbox(call)` once at window start.
 * Expects: main.html inbox markup.
 * Output: a handle whose `render(view)` redraws the list.
 */
export function mountInbox(call: Call): InboxScreen {
  /**
   * Runs an action, reloads the list, then shows the outcome.
   * Call: `await act(action)`. Expects: an rpc action.
   * Output: none; errors become Polish messages.
   */
  async function act(action: () => Promise<Outcome>): Promise<void> {
    try {
      const outcome = await action();
      render(await call('inbox.refresh', {}));
      setStatus(outcome.text, outcome.kind);
    } catch (e) {
      setStatus(messageFor(e), 'error');
    }
  }

  /**
   * Builds one list item from the template.
   * Call: `item(task)`. Expects: `#task-template`.
   * Output: the `<li>`; "biorę" only for waiting tasks, state change
   * only for tasks with an owner.
   */
  function item(task: Task): HTMLLIElement {
    const tpl = byId<HTMLTemplateElement>('task-template');
    const li = (tpl.content.firstElementChild as HTMLLIElement).cloneNode(true) as HTMLLIElement;
    li.dataset.state = task.stan;
    (li.querySelector('.desc') as HTMLElement).textContent = task.opis;
    (li.querySelector('.meta') as HTMLElement).textContent = metaText(task);
    const take = li.querySelector('.take') as HTMLButtonElement;
    const state = li.querySelector('.state') as HTMLSelectElement;
    take.hidden = task.stan !== 'nowe' && task.stan !== 'eskalowane';
    state.hidden = !task.wlasciciel;
    take.addEventListener('click', () => void act(() => takeTask(call, task.id)));
    state.addEventListener('change', () => {
      if (state.value) void act(() => changeState(call, task.id, state.value as UserSettableState));
    });
    return li;
  }

  /**
   * Redraws list and status.
   * Call: `render(view)`. Expects: a logged-in view.
   * Output: none.
   */
  function render(view: InboxView): void {
    byId('list').replaceChildren(...view.tasks.map(item));
    setStatus(statusText(view), view.offline ? 'error' : 'info');
  }

  byId('refresh').addEventListener('click', () => {
    call('inbox.refresh', {}).then(render).catch((e) => setStatus(messageFor(e), 'error'));
  });
  return { render };
}
