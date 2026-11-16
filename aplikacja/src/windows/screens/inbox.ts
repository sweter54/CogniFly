// Inbox screen: the user's tasks with "biorę" and state changes.
// Task text is inserted with textContent only (it is data).
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import { displayOrder, isFinished, selectValue } from '../../logic/inbox-view.js';
import type { InboxView } from '../protocol.js';
import { byId, messageFor, setStatus, type Call } from '../ui.js';

/** Polish names of task states. */
const STATE_NAMES: Record<string, string> = {
  nowe: 'nowe', eskalowane: 'eskalowane', wziete: 'wzięte', w_trakcie: 'w trakcie',
  do_akceptacji: 'do akceptacji', zrobione: 'zrobione',
};

/** Badge text per state (what the user sees first). */
const BADGES: Record<string, string> = {
  nowe: 'Nowe', eskalowane: 'Eskalacja', wziete: 'Wzięte', w_trakcie: 'W trakcie',
  do_akceptacji: 'Do akceptacji', zrobione: 'Zrobione ✓',
};

/** Outcome message of a user action. */
type Outcome = { text: string; kind: 'ok' | 'error' };

/** Handle returned by `mountInbox`. */
export interface InboxScreen {
  render(view: InboxView): void;
  /** Fetches the inbox now (e.g. when the user comes back). */
  refresh(): void;
  /** Scrolls to a task and makes its state badge flash. */
  highlight(taskId: string): void;
}

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
 * Output: owner and creation time in Polish (the state is shown in
 * the badge).
 */
function metaText(task: Task): string {
  const parts: string[] = [];
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

/** States in which the user works on a task (offer "Pracuj w Claude"). */
const WORKING_STATES = ['wziete', 'w_trakcie', 'do_akceptacji'];

/**
 * Opens a Claude Code session for a task.
 *
 * Call: `await openInClaude(call, id)`.
 * Expects: a task id.
 * Output: the message to show.
 */
async function openInClaude(call: Call, id: string): Promise<Outcome> {
  await call('task.openInClaude', { id });
  return { text: 'Otwieram Claude — sprawdź polecenie i wyślij je w nowej sesji.', kind: 'ok' };
}

/**
 * Wires the inbox screen.
 *
 * Call: `mountInbox(call)` once at window start.
 * Expects: main.html inbox markup.
 * Output: a handle whose `render(view)` redraws the list.
 */
export function mountInbox(call: Call): InboxScreen {
  let me: string | null = null;
  /**
   * Runs an action and shows its outcome.
   * Call: `await report(action)`. Expects: an rpc action.
   * Output: none; errors become Polish messages.
   */
  async function report(action: () => Promise<Outcome>): Promise<void> {
    try {
      const outcome = await action();
      setStatus(outcome.text, outcome.kind);
    } catch (e) {
      setStatus(messageFor(e), 'error');
    }
  }

  /**
   * Runs an action that changes tasks, reloads the list, shows outcome.
   * Call: `await act(action)`. Expects: an rpc action.
   * Output: none; errors become Polish messages.
   */
  function act(action: () => Promise<Outcome>): Promise<void> {
    return report(async () => {
      const outcome = await action();
      render(await call('inbox.refresh', {}));
      return outcome;
    });
  }

  /**
   * Builds one list item from the template.
   * Call: `item(task)`. Expects: `#task-template`.
   * Output: the `<li>`; "biorę" only for waiting tasks, state change
   * only for tasks with an owner, the select shows the current state,
   * finished tasks are marked (`data-finished`).
   */
  function item(task: Task): HTMLLIElement {
    const tpl = byId<HTMLTemplateElement>('task-template');
    const li = (tpl.content.firstElementChild as HTMLLIElement).cloneNode(true) as HTMLLIElement;
    li.dataset.state = task.stan;
    li.dataset.id = task.id;
    li.dataset.finished = String(isFinished(task));
    const badge = li.querySelector('.badge') as HTMLElement;
    badge.dataset.state = task.stan;
    badge.textContent = BADGES[task.stan] ?? task.stan;
    (li.querySelector('.desc') as HTMLElement).textContent = task.opis;
    (li.querySelector('.progress') as HTMLElement).textContent = task.postep ? `Postęp: ${task.postep}` : '';
    (li.querySelector('.meta') as HTMLElement).textContent = metaText(task);
    const take = li.querySelector('.take') as HTMLButtonElement;
    const state = li.querySelector('.state') as HTMLSelectElement;
    const mine = me !== null && task.wlasciciel === me;
    take.hidden = task.stan !== 'nowe' && task.stan !== 'eskalowane';
    state.hidden = !mine;
    state.value = selectValue(task);
    const claude = li.querySelector('.claude') as HTMLButtonElement;
    claude.hidden = !mine || !WORKING_STATES.includes(task.stan);
    claude.addEventListener('click', () => void report(() => openInClaude(call, task.id)));
    take.addEventListener('click', () => void act(() => takeTask(call, task.id)));
    state.addEventListener('change', () => {
      if (state.value) void act(() => changeState(call, task.id, state.value as UserSettableState));
    });
    return li;
  }

  /**
   * Redraws both lists and the status line.
   * Call: `render(view)`. Expects: a logged-in view.
   * Output: none; open tasks on top, finished ones under
   * "Zakończone (n)".
   */
  function render(view: InboxView): void {
    me = view.osoba;
    const ordered = displayOrder(view.tasks);
    const done = ordered.filter(isFinished);
    byId('list').replaceChildren(...ordered.filter((t) => !isFinished(t)).map(item));
    byId('done-list').replaceChildren(...done.map(item));
    const title = byId('done-title');
    title.hidden = done.length === 0;
    title.textContent = `Zakończone (${done.length})`;
    setStatus(statusText(view), view.offline ? 'error' : 'info');
  }

  /**
   * Fetches the inbox now and redraws it.
   * Call: `refresh()` (button, window focus). Expects: nothing.
   * Output: none; errors become Polish messages.
   */
  function refresh(): void {
    call('inbox.refresh', {}).then(render).catch((e) => setStatus(messageFor(e), 'error'));
  }

  /**
   * Draws attention to one task.
   * Call: `highlight(id)` after the list was rendered.
   * Expects: a task id (a missing task is ignored).
   * Output: none; the task scrolls into view and flashes for ~4 s.
   */
  function highlight(taskId: string): void {
    const li = Array.from(document.querySelectorAll<HTMLElement>('.task')).find((el) => el.dataset.id === taskId);
    if (!li) return;
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth; // restart the animation
    li.classList.add('flash');
    setTimeout(() => li.classList.remove('flash'), 4_000);
  }

  byId('refresh').addEventListener('click', refresh);
  return { render, refresh, highlight };
}
