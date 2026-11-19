// Inbox screen: the user's tasks with "biorę" and state changes.
// Task text is inserted with textContent only (it is data).
import type { Person, Task, UserSettableState } from '@cognifly/wspolne/api';
import { onRender, requestHighlight, type Highlight } from '../../logic/highlight.js';
import { displayOrder, isFinished, selectValue, taskNote } from '../../logic/inbox-view.js';
import type { HwState } from '../../logic/heartwood.js';
import type { InboxView } from '../protocol.js';
import { byId, messageFor, setStatus, type Call } from '../ui.js';
import { acceptorFormOpen, askAcceptor, closeAcceptorForm, wireAcceptor, wireFiles, wireReject, wireReturned, wireThread, type Outcome } from './task-actions.js';

/** Polish names of task states. */
const STATE_NAMES: Record<string, string> = {
  nowe: 'nowe', eskalowane: 'eskalowane', wziete: 'wzięte', w_trakcie: 'w trakcie',
  do_akceptacji: 'do akceptacji', zrobione: 'zrobione', odrzucone: 'odrzucone', usuniete: 'usunięte',
};

/** Badge text per state (what the user sees first). */
const BADGES: Record<string, string> = {
  nowe: 'Nowe', eskalowane: 'Eskalacja', wziete: 'Wzięte', w_trakcie: 'W trakcie',
  do_akceptacji: 'Do akceptacji', zrobione: 'Zrobione ✓', odrzucone: 'Odrzucone', usuniete: 'Usunięte',
};

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
 * Wires the inbox screen.
 *
 * Call: `mountInbox(call)` once at window start.
 * Expects: main.html inbox markup.
 * Output: a handle whose `render(view)` redraws the list.
 */
export function mountInbox(call: Call): InboxScreen {
  let me: string | null = null;
  let filesState: HwState = 'disabled';
  let peopleList: Promise<Person[]> | null = null;

  /**
   * Company members for the hand-over select, fetched once.
   * Call: `people()`. Expects: nothing.
   * Output: the list (a failed fetch is retried next time).
   */
  function people(): Promise<Person[]> {
    peopleList ??= call('people.list', {}).then((r) => r.people).catch((e) => {
      peopleList = null;
      throw e;
    });
    return peopleList;
  }
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
    (li.querySelector('.progress') as HTMLElement).textContent = taskNote(task) || (task.postep ? `Postęp: ${task.postep}` : '');
    (li.querySelector('.meta') as HTMLElement).textContent = metaText(task);
    const take = li.querySelector('.take') as HTMLButtonElement;
    const state = li.querySelector('.state') as HTMLSelectElement;
    const mine = me !== null && task.wlasciciel === me;
    take.hidden = task.stan !== 'nowe' && task.stan !== 'eskalowane';
    state.hidden = !mine || task.stan === 'odrzucone';
    state.value = selectValue(task);
    wireThread(li, task, mine && WORKING_STATES.includes(task.stan), call, report);
    wireReject(li, task, me, call, act);
    wireAcceptor(li, task, me, call, act);
    wireReturned(li, task, mine, people, call, act);
    wireFiles(li, task, me, filesState, call, report);
    take.addEventListener('click', () => void act(() => takeTask(call, task.id)));
    state.addEventListener('change', () => {
      if (state.value === 'do_akceptacji') return askAcceptor(li, task, people, call, act, () => (state.value = selectValue(task)));
      closeAcceptorForm(li, task.id);
      if (state.value) void act(() => changeState(call, task.id, state.value as UserSettableState));
    });
    if (mine && WORKING_STATES.includes(task.stan) && acceptorFormOpen(task.id)) {
      state.value = 'do_akceptacji';
      askAcceptor(li, task, people, call, act, () => (state.value = selectValue(task)));
    }
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
    filesState = view.files.info.state;
    const ordered = displayOrder(view.tasks);
    const done = ordered.filter(isFinished);
    const active = document.activeElement?.matches('.reason') ? document.activeElement : null;
    const typing = active ? { id: (active.closest('.task') as HTMLElement | null)?.dataset.id, form: active.closest('form')?.classList[0] } : null;
    byId('list').replaceChildren(...ordered.filter((t) => !isFinished(t)).map(item));
    if (typing?.id && typing.form) taskElement(typing.id)?.querySelector<HTMLInputElement>(`.${typing.form} .reason`)?.focus(); // keep typing
    byId('done-list').replaceChildren(...done.map(item));
    const title = byId('done-title');
    title.hidden = done.length === 0;
    title.textContent = `Zakończone (${done.length})`;
    setStatus(statusText(view), view.offline ? 'error' : 'info');
    applyHighlight();
  }

  /**
   * Fetches the inbox now and redraws it.
   * Call: `refresh()` (button, window focus). Expects: nothing.
   * Output: none; errors become Polish messages.
   */
  function refresh(): void {
    call('inbox.refresh', {}).then(render).catch((e) => setStatus(messageFor(e), 'error'));
  }

  let pending: Highlight | null = null;
  let endTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Finds the list element of a task.
   * Call: `taskElement(id)`. Expects: a task id.
   * Output: the element or undefined when it is not on the list.
   */
  function taskElement(taskId: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('.task')).find((el) => el.dataset.id === taskId);
  }

  /**
   * Applies the pending highlight to the current list.
   * Call: after every render and when a highlight is requested.
   * Expects: nothing. Output: none; on start the task scrolls into
   * view, gets focus and flashes; redraws keep the flash until it
   * ends (redraws replace the elements).
   */
  function applyHighlight(): void {
    const li = pending ? taskElement(pending.id) : undefined;
    const { next, flash } = onRender(pending, li !== undefined, Date.now());
    pending = next;
    if (!li || flash === 'none') return;
    li.classList.add('flash');
    if (flash !== 'start') return;
    li.tabIndex = -1;
    if (!document.activeElement?.matches('input, textarea, select')) li.focus({ preventScroll: true }); // don't steal typing
    li.scrollIntoView({ block: 'center', behavior: 'smooth' });
    clearTimeout(endTimer);
    endTimer = setTimeout(endHighlight, (next?.until ?? Date.now()) - Date.now());
  }

  /**
   * Ends the flash on whatever element shows the task now.
   * Call: by the timer. Expects: nothing. Output: none.
   */
  function endHighlight(): void {
    const id = pending?.id;
    pending = onRender(pending, false, Date.now()).next;
    if (id && !pending) taskElement(id)?.classList.remove('flash');
  }

  /**
   * Draws attention to one task for 5 s.
   * Call: `highlight(id)` when the app was opened on a task.
   * Expects: a task id; a task not on the list yet is highlighted
   * when it appears (up to 15 s; the inbox is fetched at once).
   * Output: none.
   */
  function highlight(taskId: string): void {
    for (const el of Array.from(document.querySelectorAll('.task.flash'))) el.classList.remove('flash');
    pending = requestHighlight(taskId, Date.now());
    applyHighlight();
    if (pending && pending.until === undefined) refresh();
  }

  byId('refresh').addEventListener('click', refresh);
  return { render, refresh, highlight };
}
