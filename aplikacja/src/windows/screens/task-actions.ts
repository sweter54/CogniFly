// Extra task controls of the inbox: Claude thread, rejection and the
// sender's choices for a rejected task. Person text (the reason) is
// shown with textContent only: it is data.
import type { Person, Task } from '@cognifly/wspolne/api';
import { canReject, isAcceptor } from '../../logic/inbox-view.js';
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

/** One button that opens a reason form and sends the reason. */
interface ReasonForm {
  /** Button that opens the form, e.g. `.reject`. */
  button: string;
  /** The form, e.g. `.reject-form` (holds `.reason` and `.cancel`). */
  form: string;
  /** Whether the button is offered for this task. */
  show: boolean;
  /** Sends the reason; returns the outcome message. */
  send: (reason: string) => Promise<Outcome>;
}

/**
 * Wires a button + reason form pair.
 *
 * Call: `wireReasonForm(li, task, spec, act)`.
 * Expects: the template markup named in `spec`.
 * Output: none; an open form and its unsent text survive redraws of
 * the list (kept per task and form).
 */
function wireReasonForm(li: HTMLElement, task: Task, spec: ReasonForm, act: Act): void {
  const button = part<HTMLButtonElement>(li, spec.button);
  const form = part<HTMLFormElement>(li, spec.form);
  const reason = part<HTMLInputElement>(form, '.reason');
  const key = `${spec.form}:${task.id}`;
  button.hidden = !spec.show;
  const toggle = (open: boolean) => {
    form.hidden = !open;
    button.hidden = open || !spec.show;
    if (open) {
      drafts.set(key, reason.value); // the open form survives redraws
      reason.focus();
    } else drafts.delete(key);
  };
  if (drafts.has(key) && spec.show) {
    reason.value = drafts.get(key) ?? '';
    form.hidden = false;
    button.hidden = true;
  }
  button.addEventListener('click', () => toggle(true));
  part<HTMLButtonElement>(form, '.cancel').addEventListener('click', () => toggle(false));
  reason.addEventListener('input', () => drafts.set(key, reason.value));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = reason.value;
    void act(async () => {
      const outcome = await spec.send(text);
      drafts.delete(key);
      return outcome;
    });
  });
}

/**
 * Sets up "Odrzuć" with its reason form.
 *
 * Call: `wireReject(li, task, me, call, act)`.
 * Expects: the user's person id (null when unknown).
 * Output: none; the button shows only when `canReject`.
 */
export function wireReject(li: HTMLElement, task: Task, me: string | null, call: Call, act: Act): void {
  wireReasonForm(li, task, {
    button: '.reject', form: '.reject-form', show: canReject(task, me),
    send: async (reason) => {
      await call('task.reject', { id: task.id, reason });
      return { text: 'Odrzucono — zadanie wróciło do nadawcy.', kind: 'ok' };
    },
  }, act);
}

/**
 * Sets up the acceptor's "Akceptuj" and "Do poprawy".
 *
 * Call: `wireAcceptor(li, task, me, call, act)`.
 * Expects: the user's person id.
 * Output: none; both show only for the named acceptor of a
 * `do_akceptacji` task; "Do poprawy" asks what to fix.
 */
export function wireAcceptor(li: HTMLElement, task: Task, me: string | null, call: Call, act: Act): void {
  const show = isAcceptor(task, me);
  const approve = part<HTMLButtonElement>(li, '.approve');
  approve.hidden = !show;
  approve.addEventListener('click', () => void act(async () => {
    await call('task.accept', { id: task.id });
    return { text: 'Zaakceptowano — zadanie zrobione.', kind: 'ok' };
  }));
  wireReasonForm(li, task, {
    button: '.fix', form: '.fix-form', show,
    send: async (reason) => {
      await call('task.sendBack', { id: task.id, reason });
      return { text: 'Odesłano do poprawy.', kind: 'ok' };
    },
  }, act);
}

/**
 * Opens the "who accepts it" form for the owner's task.
 *
 * Call: `askAcceptor(li, task, people, call, act, reset)` when the
 * user picks "Do akceptacji" in the state select.
 * Expects: `people` resolves to company members; `reset` puts the
 * state select back.
 * Output: none; the sender is preselected; sending sets the state
 * with the chosen person; the open form survives redraws.
 */
export function askAcceptor(
  li: HTMLElement, task: Task, people: () => Promise<Person[]>, call: Call, act: Act, reset: () => void,
): void {
  const form = part<HTMLFormElement>(li, '.accept-form');
  const select = part<HTMLSelectElement>(form, '.acceptor');
  const key = `.accept-form:${task.id}`;
  const preset = drafts.get(key) ?? (task.nadawca && task.nadawca !== task.wlasciciel ? task.nadawca : '');
  drafts.set(key, preset); // the open form survives redraws
  form.hidden = false;
  void people().then((list) => {
    select.replaceChildren(new Option('Wybierz osobę…', ''));
    for (const p of list.filter((x) => x.osoba !== task.wlasciciel)) select.add(new Option(p.osoba, p.osoba));
    select.value = preset;
  }).catch(() => undefined);
  select.onchange = () => drafts.set(key, select.value);
  part<HTMLButtonElement>(form, '.cancel').onclick = () => {
    drafts.delete(key);
    form.hidden = true;
    reset();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const acceptor = select.value;
    if (!acceptor) return;
    void act(async () => {
      await call('inbox.setState', { id: task.id, state: 'do_akceptacji', acceptor });
      drafts.delete(key);
      return { text: `Wysłano do akceptacji: ${acceptor}.`, kind: 'ok' };
    });
  };
}

/**
 * Sets up the sender's choices for a task rejected back to them.
 *
 * Call: `wireReturned(li, task, mine, people, call, act)`.
 * Expects: `mine` = the user owns the task; `people` resolves to the
 * company members (fetched once per window).
 * Output: none; "Usuń" (asks twice) and a person select with a
 * "Przekaż: <osoba>" button.
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

/**
 * Tells whether the "who accepts it" form is open for a task.
 * Call: `acceptorFormOpen(id)` while building the list.
 * Expects: a task id. Output: true when it should be reopened.
 */
export function acceptorFormOpen(taskId: string): boolean {
  return drafts.has(`.accept-form:${taskId}`);
}
