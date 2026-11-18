// Extra task controls of the inbox: Claude thread, rejection and the
// sender's choices for a rejected task. Person text (the reason) is
// shown with textContent only: it is data.
import type { Person, Task } from '@cognifly/wspolne/api';
import { canReject, rejectionText } from '../../logic/inbox-view.js';
import type { Call } from '../ui.js';

/** Outcome message of a user action. */
export type Outcome = { text: string; kind: 'ok' | 'error' };
/** Runs an action that changes tasks (reloads the list). */
export type Act = (action: () => Promise<Outcome>) => Promise<void>;
/** Runs an action that only shows its outcome. */
export type Report = (action: () => Promise<Outcome>) => Promise<void>;

/** Unsent rejection reasons, kept across redraws of the list. */
const drafts = new Map<string, string>();

/**
 * Finds a control inside a task item.
 * Call: `part(li, '.reject')`. Expects: the task template markup.
 * Output: the element.
 */
function part<T extends HTMLElement>(li: HTMLElement, selector: string): T {
  return li.querySelector(selector) as T;
}

/**
 * Sets up "Wróć do wątku w Claude" next to "Pracuj w Claude".
 *
 * Call: `wireThread(li, task, show, call, report)`.
 * Expects: `show` = the user works on the task now.
 * Output: none; with a remembered thread the main button returns to
 * it and the second one opens a new thread.
 */
export function wireThread(li: HTMLElement, task: Task, show: boolean, call: Call, report: Report): void {
  const thread = part<HTMLButtonElement>(li, '.thread');
  const claude = part<HTMLButtonElement>(li, '.claude');
  claude.hidden = !show;
  thread.hidden = !show || !task.watek;
  if (task.watek) claude.textContent = 'Nowy wątek';
  const open = (newThread: boolean) => report(async () => {
    await call('task.openInClaude', { id: task.id, newThread });
    return { text: newThread ? 'Otwieram nowy wątek w Claude — wyślij polecenie.' : 'Wracam do wątku w Claude.', kind: 'ok' };
  });
  thread.addEventListener('click', () => void open(false));
  claude.addEventListener('click', () => void open(true));
}

/**
 * Sets up "Odrzuć" with its reason form.
 *
 * Call: `wireReject(li, task, me, call, act)`.
 * Expects: the user's person id (null when unknown).
 * Output: none; the button shows only when `canReject`; an unsent
 * reason survives list redraws.
 */
export function wireReject(li: HTMLElement, task: Task, me: string | null, call: Call, act: Act): void {
  const button = part<HTMLButtonElement>(li, '.reject');
  const form = part<HTMLFormElement>(li, '.reject-form');
  const reason = part<HTMLInputElement>(li, '.reason');
  button.hidden = !canReject(task, me);
  const toggle = (open: boolean) => {
    form.hidden = !open;
    button.hidden = open || !canReject(task, me);
    if (open) {
      drafts.set(task.id, reason.value); // the open form survives redraws
      reason.focus();
    } else drafts.delete(task.id);
  };
  if (drafts.has(task.id) && canReject(task, me)) {
    reason.value = drafts.get(task.id) ?? '';
    form.hidden = false;
    button.hidden = true;
  }
  button.addEventListener('click', () => toggle(true));
  part<HTMLButtonElement>(li, '.cancel').addEventListener('click', () => toggle(false));
  reason.addEventListener('input', () => drafts.set(task.id, reason.value));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = reason.value;
    void act(async () => {
      await call('task.reject', { id: task.id, reason: text });
      drafts.delete(task.id);
      return { text: 'Odrzucono — zadanie wróciło do nadawcy.', kind: 'ok' };
    });
  });
}

/**
 * Sets up the sender's choices for a task rejected back to them.
 *
 * Call: `wireReturned(li, task, mine, people, call, act)`.
 * Expects: `mine` = the user owns the task; `people` resolves to the
 * company members (fetched once per window).
 * Output: none; shows who rejected and why, "Usuń" (asks twice) and
 * a person select with a "Przekaż: <osoba>" button.
 */
export function wireReturned(
  li: HTMLElement, task: Task, mine: boolean, people: () => Promise<Person[]>, call: Call, act: Act,
): void {
  const returned = mine && task.stan === 'odrzucone';
  const remove = part<HTMLButtonElement>(li, '.remove');
  const handover = part<HTMLSelectElement>(li, '.person');
  remove.hidden = !returned;
  handover.hidden = !returned;
  part<HTMLButtonElement>(li, '.handover').hidden = true;
  const why = rejectionText(task);
  if (why) part<HTMLElement>(li, '.progress').textContent = why;
  if (!returned) return;
  void people().then((list) => {
    for (const p of list.filter((x) => x.osoba !== task.wlasciciel)) handover.add(new Option(p.osoba, p.osoba));
  }).catch(() => undefined);
  armed(remove, 'Na pewno usunąć?', () => act(async () => {
    await call('task.remove', { id: task.id });
    return { text: 'Zadanie usunięte.', kind: 'ok' };
  }));
  const confirm = part<HTMLButtonElement>(li, '.handover');
  handover.addEventListener('change', () => {
    confirm.hidden = !handover.value;
    confirm.textContent = `Przekaż: ${handover.value}`;
  });
  confirm.addEventListener('click', () => {
    const person = handover.value;
    if (!person) return;
    void act(async () => {
      await call('task.handOver', { id: task.id, person });
      return { text: `Przekazano: ${person}.`, kind: 'ok' };
    });
  });
}

/**
 * Makes a button ask for a second click before a final action.
 *
 * Call: `armed(button, 'Na pewno…?', action)`.
 * Expects: a visible button.
 * Output: none; the first click changes the label for 5 s, a second
 * click in that time runs the action.
 */
function armed(button: HTMLButtonElement, question: string, action: () => Promise<void>): void {
  const label = button.textContent ?? '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    if (timer === undefined) {
      button.textContent = question;
      timer = setTimeout(() => {
        button.textContent = label;
        timer = undefined;
      }, 5_000);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    button.textContent = label;
    void action();
  });
}
