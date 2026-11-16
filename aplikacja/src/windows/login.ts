// Login window: e-mail → one-time code from the e-mail. Tokens never
// reach this window; the background window keeps them.
import { byId, connect, formValues, hideSelf, messageFor, setBusy, setStatus, type Call } from './ui.js';

/**
 * Switches between the e-mail step and the code step.
 *
 * Call: `showStep('code', email)` or `showStep('email')`.
 * Expects: login.html markup.
 * Output: none; the visible form's first input is focused.
 */
function showStep(step: 'email' | 'code', email = ''): void {
  const emailForm = byId<HTMLFormElement>('email-form');
  const codeForm = byId<HTMLFormElement>('code-form');
  emailForm.hidden = step !== 'email';
  codeForm.hidden = step !== 'code';
  byId('email-shown').textContent = email;
  const active = step === 'email' ? emailForm : codeForm;
  (active.querySelector('input') as HTMLInputElement | null)?.focus();
}

/**
 * Runs one form step with busy state and error display.
 *
 * Call: `await runStep(form, action)`.
 * Expects: an async action using the form's values.
 * Output: none; errors become Polish status messages.
 */
async function runStep(form: HTMLFormElement, action: (values: Record<string, string>) => Promise<void>): Promise<void> {
  setBusy(form, true);
  setStatus('');
  try {
    await action(formValues(form));
  } catch (e) {
    setStatus(messageFor(e), 'error');
  } finally {
    setBusy(form, false);
  }
}

/**
 * Wires both forms.
 *
 * Call: `wire(call)` once.
 * Expects: a connected `call`.
 * Output: none. After a successful login the form resets and the
 * window hides itself.
 */
function wire(call: Call): void {
  const emailForm = byId<HTMLFormElement>('email-form');
  const codeForm = byId<HTMLFormElement>('code-form');
  emailForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void runStep(emailForm, async ({ email }) => {
      const r = await call('login.sendCode', { email: email ?? '' });
      showStep('code', r.email);
      setStatus('Kod wysłany. Wiadomość może trafić do spamu.', 'info');
    });
  });
  codeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void runStep(codeForm, async ({ code }) => {
      const r = await call('login.confirm', { code: code ?? '' });
      setStatus(`Zalogowano jako ${r.email}.`, 'ok');
      codeForm.reset();
      showStep('email');
      await hideSelf();
    });
  });
  byId('back').addEventListener('click', () => showStep('email'));
}

/**
 * Window entry.
 *
 * Call: once at module load.
 * Expects: login.html markup.
 * Output: none.
 */
async function main(): Promise<void> {
  wire(await connect());
  showStep('email');
}

main().catch((e) => setStatus(messageFor(e), 'error'));
