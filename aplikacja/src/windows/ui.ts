// Helpers shared by the visible windows (settings, login, inbox):
// typed rpc calls, Polish messages for error codes and DOM utilities.
// Text from the network is always set via `textContent`.
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { rpcClient, RpcError } from '../logic/rpc.js';
import type { Method, Methods } from './protocol.js';
import { currentLabel, tauriBus } from './tauri-bus.js';

/** Typed call into the background window. */
export type Call = <M extends Method>(method: M, params: Methods[M]['params']) => Promise<Methods[M]['result']>;

/**
 * Connects the current window to the background window.
 *
 * Call: `const call = await connect()` at window start.
 * Expects: a UI window with event permissions.
 * Output: a typed `call(method, params)` function.
 */
export async function connect(): Promise<Call> {
  const raw = await rpcClient(tauriBus(), currentLabel());
  return ((method, params) => raw(method, params)) as Call;
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
  UNEXPECTED_CHALLENGE: 'Serwer logowania poprosił o nieobsługiwany krok.',
  BRAK_DOSTEPU: 'Brak dostępu do tej firmy lub zadania.',
  NIE_ZNALEZIONO: 'Nie znaleziono zadania.',
  ZLY_STAN: 'Niedozwolona zmiana stanu.',
  TooManyRequestsException: 'Za dużo prób. Odczekaj kilka minut.',
  LimitExceededException: 'Za dużo prób. Odczekaj kilka minut.',
  TIMEOUT: 'Aplikacja nie odpowiada. Spróbuj ponownie.',
  VAULT_ERROR: 'Brak dostępu do Pęku kluczy.',
  VAULT_UNAVAILABLE: 'Pęk kluczy jest niedostępny.',
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
