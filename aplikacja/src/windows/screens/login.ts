// Guided login screen: e-mail → code → done. Tokens never reach this
// window; the background window keeps them.
import { byId, formValues, messageFor, setBusy, setStatus, type Call } from '../ui.js';

/** Steps of the guided login. */
export type LoginStep = 'email' | 'code' | 'done';

/** Handle returned by `mountLogin`. */
export interface LoginScreen { reset(): void }

/**
 * Shows one step and marks progress.
 *
 * Call: `showStep('code')`.
 * Expects: main.html login markup (`data-pane`, `data-step`).
 * Output: none; the step's first input gets focus.
 */
function showStep(step: LoginStep): void {
  const root = byId('screen-login');
  const order: LoginStep[] = ['email', 'code', 'done'];
  for (const pane of Array.from(root.querySelectorAll<HTMLElement>('[data-pane]'))) pane.hidden = pane.dataset.pane !== step;
  for (const li of Array.from(root.querySelectorAll<HTMLElement>('[data-step]'))) {
    const at = order.indexOf(li.dataset.step as LoginStep);
    li.dataset.state = at < order.indexOf(step) ? 'done' : at === order.indexOf(step) ? 'current' : 'todo';
  }
  root.querySelector<HTMLInputElement>(`[data-pane="${step}"] input`)?.focus();
}

/**
 * Runs one async step with busy state and Polish error messages.
 *
 * Call: `await runStep(form, (values) => ...)`.
 * Expects: an action that may throw rpc errors.
 * Output: none. Values are read BEFORE the form is disabled, because
 * disabled fields are left out of `FormData`.
 */
async function runStep(form: HTMLFormElement, action: (values: Record<string, string>) => Promise<void>): Promise<void> {
  const values = formValues(form);
  setBusy(form, true);
  setStatus('');
  try {
    await action(values);
  } catch (e) {
    setStatus(messageFor(e), 'error');
  } finally {
    setBusy(form, false);
  }
}

/**
 * Requests a code and moves to the code step.
 *
 * Call: `await sendCode(call, email)`.
 * Expects: an e-mail address.
 * Output: none; the address is shown in the code step.
 */
async function sendCode(call: Call, email: string): Promise<void> {
  const r = await call('login.sendCode', { email });
  byId('email-shown').textContent = r.email;
  showStep('code');
  setStatus('Kod wysłany.', 'ok');
}

/**
 * Wires the login screen.
 *
 * Call: `mountLogin(call)` once at window start.
 * Expects: main.html login markup.
 * Output: a handle whose `reset()` returns to the e-mail step.
 */
export function mountLogin(call: Call): LoginScreen {
  const emailForm = byId<HTMLFormElement>('email-form');
  const codeForm = byId<HTMLFormElement>('code-form');
  let email = '';
  emailForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void runStep(emailForm, (values) => {
      email = values.email ?? '';
      return sendCode(call, email);
    });
  });
  codeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void runStep(codeForm, async (values) => {
      const r = await call('login.confirm', { code: values.code ?? '' });
      codeForm.reset();
      byId('email-done').textContent = r.email;
      showStep('done');
    });
  });
  byId('resend').addEventListener('click', () => void runStep(codeForm, () => sendCode(call, email)));
  byId('change-email').addEventListener('click', () => showStep('email'));
  showStep('email');
  return { reset: () => showStep('email') };
}
