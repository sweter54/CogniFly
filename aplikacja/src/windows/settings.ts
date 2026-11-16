// Settings window: edit API address, Cognito client, region, company.
import type { AppConfig } from '../logic/config.js';
import { byId, connect, formValues, messageFor, setBusy, setStatus, type Call } from './ui.js';

const FIELD_LABELS: Record<keyof AppConfig, string> = {
  apiUrl: 'Adres API musi zaczynać się od https:// i nie może zawierać parametrów.',
  clientId: 'Klient Cognito może zawierać tylko litery i cyfry.',
  region: 'Region ma postać np. eu-central-1.',
  company: 'Firma: małe litery, cyfry i myślniki.',
};

/**
 * Fills the form with a config.
 *
 * Call: `fill(form, config)`.
 * Expects: inputs named like `AppConfig` keys.
 * Output: none.
 */
function fill(form: HTMLFormElement, config: AppConfig): void {
  for (const [name, value] of Object.entries(config)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.value = value;
  }
}

/**
 * Saves the form through the background window.
 *
 * Call: on form submit.
 * Expects: a connected `call`.
 * Output: none; shows success or the field-specific problem.
 */
async function save(call: Call, form: HTMLFormElement): Promise<void> {
  setBusy(form, true);
  try {
    const r = await call('config.save', { config: formValues(form) as unknown as AppConfig });
    if (r.ok) setStatus('Zapisano.', 'ok');
    else setStatus(FIELD_LABELS[r.field], 'error');
  } catch (e) {
    setStatus(messageFor(e), 'error');
  } finally {
    setBusy(form, false);
  }
}

/**
 * Window entry.
 *
 * Call: once at module load.
 * Expects: settings.html markup.
 * Output: none; loads the current config into the form.
 */
async function main(): Promise<void> {
  const form = byId<HTMLFormElement>('form');
  const call = await connect();
  const { config, defaults } = await call('config.get', {});
  fill(form, config);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void save(call, form);
  });
  byId('defaults').addEventListener('click', () => fill(form, defaults));
  window.addEventListener('focus', () => void call('config.get', {}).then((r) => fill(form, r.config)));
}

main().catch((e) => setStatus(messageFor(e), 'error'));
