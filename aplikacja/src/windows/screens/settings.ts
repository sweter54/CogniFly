// Settings screen: API address, Cognito client, region, company.
import type { AppConfig } from '../../logic/config.js';
import { byId, formValues, messageFor, setBusy, setStatus, type Call } from '../ui.js';

/** Polish hints for invalid fields. */
const FIELD_HINTS: Record<keyof AppConfig, string> = {
  apiUrl: 'Adres API musi zaczynać się od https:// i nie może zawierać parametrów.',
  clientId: 'Klient Cognito może zawierać tylko litery i cyfry.',
  region: 'Region ma postać np. eu-central-1.',
  company: 'Firma: małe litery, cyfry i myślniki.',
  workFolder: 'Folder pracy: pełna ścieżka zaczynająca się od / (bez „..”), albo puste pole.',
};

/** Handle returned by `mountSettings`. */
export interface SettingsScreen { load(): Promise<void> }

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
 * Call: `await save(call, form)` on submit.
 * Expects: a connected `call`.
 * Output: none; shows success or the field-specific hint.
 */
async function save(call: Call, form: HTMLFormElement): Promise<void> {
  const values = formValues(form); // before disabling: FormData skips disabled fields
  setBusy(form, true);
  try {
    const r = await call('config.save', { config: values as unknown as AppConfig });
    setStatus(r.ok ? 'Zapisano.' : FIELD_HINTS[r.field], r.ok ? 'ok' : 'error');
  } catch (e) {
    setStatus(messageFor(e), 'error');
  } finally {
    setBusy(form, false);
  }
}

/**
 * Wires the settings screen.
 *
 * Call: `mountSettings(call, back)` once; `back` leaves the screen.
 * Expects: main.html settings markup.
 * Output: a handle whose `load()` refreshes the form from the
 * background window (call it each time the screen opens).
 */
export function mountSettings(call: Call, back: () => void): SettingsScreen {
  const form = byId<HTMLFormElement>('settings-form');
  let defaults: AppConfig | null = null;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void save(call, form);
  });
  byId('defaults').addEventListener('click', () => defaults && fill(form, defaults));
  byId('settings-back').addEventListener('click', back);
  return {
    async load() {
      const r = await call('config.get', {});
      defaults = r.defaults;
      fill(form, r.config);
    },
  };
}
