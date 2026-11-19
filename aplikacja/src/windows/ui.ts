// Helpers shared by the visible windows (settings, login, inbox, files):
// typed rpc calls, Polish messages for error codes and DOM utilities.
// Text from the network is always set via `textContent`.
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { fileErrorText } from '../logic/files-view.js';
import { rpcClient, RpcError } from '../logic/rpc.js';
import type { Method, Methods } from './protocol.js';
import { currentLabel, tauriBus } from './tauri-bus.js';

/** Typed call into the background window. */
export type Call = <M extends Method>(method: M, params: Methods[M]['params'], waitMs?: number) => Promise<Methods[M]['result']>;

/**
 * Connects the current window to the background window.
 *
 * Call: `const call = await connect()` at window start.
 * Expects: a UI window with event permissions.
 * Output: a typed `call(method, params)` function.
 */
export async function connect(): Promise<Call> {
  const raw = await rpcClient(tauriBus(), currentLabel());
  return ((method, params, waitMs) => raw(method, params, waitMs)) as Call;
}

/** Polish messages for stable error codes. */
const MESSAGES: Record<string, string> = {
  NETWORK: 'Brak połączenia z serwerem. Spróbuj ponownie za chwilę.',
  LOGIN_REQUIRED: 'Zaloguj się ponownie.',
  BAD_EMAIL: 'Podaj poprawny adres e-mail.',
  WRONG_CODE: 'Kod jest nieprawidłowy. Użyj kodu z najnowszego maila.',
  CODE_EXPIRED: 'Kod wygasł. Kliknij „Wyślij nowy kod”.',
  SESSION_EXPIRED: 'Logowanie wygasło (kod jest ważny ok. 3 minuty). Kliknij „Wyślij nowy kod”.',
  NO_PENDING_LOGIN: 'Najpierw wyślij kod na e-mail.',
  UNEXPECTED_CHALLENGE: 'Logowanie nie powiodło się. Spróbuj ponownie od wpisania adresu e-mail.',
  NO_ACCOUNT: 'Ten adres nie ma aktywnego konta w CogniFly. Sprawdź adres albo poproś administratora firmy o dodanie Cię.',
  BRAK_DOSTEPU: 'Brak dostępu do tej firmy lub zadania.',
  NIE_ZNALEZIONO: 'Nie znaleziono zadania.',
  ZLY_STAN: 'Niedozwolona zmiana stanu.',
  ZLY_POWOD: 'Podaj krótki powód (do 200 znaków).',
  ZLA_OSOBA: 'Wybierz osobę z listy.',
  BRAK_NADAWCY: 'Tego zadania nie da się odrzucić — nie ma nadawcy.',
  BRAK_OSOBY: 'Tej osoby nie ma w firmie.',
  KONFLIKT: 'Zadanie zmieniło się w międzyczasie — odśwież listę.',
  BAD_THREAD: 'Nieprawidłowy wątek Claude.',
  TooManyRequestsException: 'Za dużo prób. Odczekaj kilka minut.',
  LimitExceededException: 'Za dużo prób. Odczekaj kilka minut.',
  TIMEOUT: 'Aplikacja nie odpowiada. Spróbuj ponownie.',
  VAULT_ERROR: 'Brak dostępu do Pęku kluczy.',
  VAULT_UNAVAILABLE: 'Pęk kluczy jest niedostępny.',
  CLAUDE_NOT_FOUND: 'Nie znaleziono aplikacji Claude. Zainstaluj Claude na Maca i spróbuj ponownie.',
  BAD_TASK_ID: 'Nieprawidłowy identyfikator zadania.',
  BAD_COMPANY: 'Nie należysz do tej firmy.',
  ZLE_REPO: 'Podaj repozytorium w postaci właściciel/nazwa.',
  ZLY_PR: 'Podaj numer PR (liczba).',
  ZLI_RECENZENCI: 'Wybierz co najmniej jedną osobę z firmy.',
  BRAK_PR: 'Nie ma takiego PR (albo CogniFly go nie widzi).',
  PR_ZAMKNIETY: 'Ten PR jest już zamknięty.',
  NO_WORK_FOLDER: 'Najpierw wybierz folder pracy.',
  BAD_FOLDER: 'Tego folderu nie można użyć. Wybierz folder na tym Macu (pełna ścieżka).',
};

/**
 * Polish message for an error.
 *
 * Call: `messageFor(e)` in catch blocks.
 * Expects: anything thrown by `call`.
 * Output: a user-facing sentence; unknown codes get a generic text
 * with the code (codes never contain user data).
 */
export function messageFor(e: unknown): string {
  const code = e instanceof RpcError ? e.code : 'UNEXPECTED';
  return MESSAGES[code] ?? `Coś poszło nie tak (${code}).`;
}

/**
 * Finds a required element by id.
 *
 * Call: `byId<HTMLFormElement>('form')`.
 * Expects: the element to exist in the page.
 * Output: the element.
 * Throws: `Error` when missing (a page/script mismatch).
 */
export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/**
 * Shows a status line.
 *
 * Call: `setStatus(text, 'error')`; empty text clears it.
 * Expects: a `#status` element in the page.
 * Output: none; text set via `textContent`, kind via `data-kind`.
 */
export function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = byId('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

/**
 * Disables or enables all buttons and inputs of a form while busy.
 *
 * Call: `setBusy(form, true)` before a call, `false` after.
 * Expects: a form element.
 * Output: none.
 */
export function setBusy(form: HTMLFormElement, busy: boolean): void {
  for (const el of Array.from(form.elements)) (el as HTMLButtonElement).disabled = busy;
}

/**
 * Reads a form's text fields.
 *
 * Call: `formValues(form)`.
 * Expects: inputs with `name` attributes, NOT disabled (FormData
 * omits disabled fields) — read values before `setBusy(form, true)`.
 * Output: name → string value.
 */
export function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(Array.from(new FormData(form), ([k, v]) => [k, String(v)]));
}

/**
 * Hides the current window.
 *
 * Call: `await hideSelf()`.
 * Expects: `core:window:allow-hide`.
 * Output: none.
 */
export async function hideSelf(): Promise<void> {
  await getCurrentWebviewWindow().hide();
}

/** How long to wait for the user in a system file dialog. */
export const PICKER_WAIT_MS = 10 * 60_000;
/** How long to wait for a slow Heartwood command (up to 120 s). */
export const DAEMON_WAIT_MS = 130_000;

/**
 * Asks the background window to show the folder picker.
 *
 * Call: `await pickFolder(call, currentPath)`.
 * Expects: a connected `call`; `currentPath` may be `''`.
 * Output: the chosen path, or `null` when cancelled. Waits up to
 * 10 minutes for the user.
 * Throws: `RpcError` (e.g. `BAD_FOLDER`).
 */
export async function pickFolder(call: Call, currentPath: string): Promise<string | null> {
  const { path } = await call('config.pickFolder', { current: currentPath }, PICKER_WAIT_MS);
  return path;
}

/** Buttons that show a question and wait for a second click. */
const primed = new WeakMap<HTMLButtonElement, { label: string; timer: ReturnType<typeof setTimeout> }>();

/**
 * Shows a question on a button for 5 s.
 *
 * Call: `prime(button, 'Na pewno…?')`; check with `takePrimed`.
 * Expects: a visible button.
 * Output: none; the label comes back after 5 s.
 */
export function prime(button: HTMLButtonElement, question: string): void {
  const label = primed.get(button)?.label ?? button.textContent ?? '';
  clearTimeout(primed.get(button)?.timer);
  button.textContent = question;
  primed.set(button, { label, timer: setTimeout(() => takePrimed(button), 5_000) });
}

/**
 * Ends a question shown by `prime`.
 *
 * Call: `takePrimed(button)` on the next click.
 * Expects: any button.
 * Output: true when the question was still shown (the click
 * confirms it); the label is restored either way.
 */
export function takePrimed(button: HTMLButtonElement): boolean {
  const p = primed.get(button);
  if (!p) return false;
  clearTimeout(p.timer);
  primed.delete(button);
  button.textContent = p.label;
  return true;
}

/**
 * Makes a button ask for a second click before a final action.
 *
 * Call: `armed(button, 'Na pewno…?', action)`.
 * Expects: a visible button.
 * Output: none; the first click shows the question for 5 s, a
 * second click in that time runs the action.
 */
export function armed(button: HTMLButtonElement, question: string, action: () => Promise<void>): void {
  button.addEventListener('click', () => {
    if (takePrimed(button)) void action();
    else prime(button, question);
  });
}

/** Status line text with its kind. */
export type Said = { text: string; kind: 'info' | 'ok' | 'error' };

/**
 * Builds an element with text.
 *
 * Call: `el('span', text, 'muted')`.
 * Expects: a tag name; text is data (set via `textContent`).
 * Output: the element.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/**
 * Builds a button that is not a form submit.
 *
 * Call: `button('Zwolnij', 'secondary')`.
 * Expects: the label and optional classes.
 * Output: the `<button type="button">`.
 */
export function button(label: string, cls?: string): HTMLButtonElement {
  const b = el('button', label, cls);
  b.type = 'button';
  return b;
}

/**
 * Builds one list row from its parts.
 *
 * Call: `row(el('strong', path), el('span', note))`.
 * Expects: nodes in display order.
 * Output: the `<li>`.
 */
export function row(...parts: Node[]): HTMLLIElement {
  const li = document.createElement('li');
  li.append(...parts);
  return li;
}

/**
 * Runs a file action from a button and shows its outcome.
 *
 * Call: `await runFileAction(button, action)`.
 * Expects: an action resolving to the text to show.
 * Output: none; the button is disabled meanwhile; errors become
 * `hwMessage` texts.
 */
export async function runFileAction(b: HTMLButtonElement, action: () => Promise<Said>): Promise<void> {
  b.disabled = true;
  try {
    const said = await action();
    setStatus(said.text, said.kind);
  } catch (e) {
    setStatus(fileErrorText(e), 'error');
  } finally {
    b.disabled = false;
  }
}
