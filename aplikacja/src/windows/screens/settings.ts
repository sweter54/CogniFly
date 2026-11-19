// Settings screen: who I am (from the server), my company (choice only
// when I belong to several), the work folder and "change account".
// Connection values are built into the app and not shown here.
import type { Methods } from '../protocol.js';
import { byId, messageFor, pickFolder, setPath, setStatus, type Call } from '../ui.js';

/** Account data shown on the screen. */
type Account = Methods['account.get']['result'];

/** Handle returned by `mountSettings`. */
export interface SettingsScreen {
  /** Refreshes account, company and folder (call when opening). */
  load(): Promise<void>;
  /** Shows the current folder (after it changed elsewhere). */
  showFolder(path: string): void;
}

/**
 * Renders the account line.
 *
 * Call: `renderAccount(account)`.
 * Expects: settings markup (`#account-email`, `#account-id`).
 * Output: none; e-mail and id via `textContent`.
 */
function renderAccount(account: Account): void {
  byId('account-email').textContent = account.email ?? '—';
  byId('account-id').textContent = account.osoba ?? '…';
}

/**
 * Renders the company: plain text for one, a select for several.
 *
 * Call: `renderCompany(account)`.
 * Expects: `#company-name` and `#company-select` in the markup.
 * Output: none.
 */
function renderCompany(account: Account): void {
  const name = byId('company-name');
  const select = byId<HTMLSelectElement>('company-select');
  const many = account.companies.length > 1;
  name.hidden = many;
  select.hidden = !many;
  name.textContent = account.company;
  select.replaceChildren(...account.companies.map((m) => new Option(`${m.firma} (${m.osoba})`, m.firma)));
  select.value = account.company;
}

/**
 * Picks a folder and saves it at once.
 *
 * Call: `await changeFolder(call, shown)` on "Wybierz…".
 * Expects: the element showing the folder (full path in `title`).
 * Output: none; cancel keeps the old folder; errors are shown.
 */
async function changeFolder(call: Call, shown: HTMLElement): Promise<void> {
  try {
    const path = await pickFolder(call, shown.title);
    if (path === null) return;
    await call('config.setWorkFolder', { path });
    setPath(shown, path);
    setStatus('Zapisano folder pracy.', 'ok');
  } catch (e) {
    setStatus(messageFor(e), 'error');
  }
}

/**
 * Switches the company.
 *
 * Call: `await changeCompany(call, company)` on select change.
 * Expects: a company from the list.
 * Output: none; shows the outcome.
 */
async function changeCompany(call: Call, company: string): Promise<void> {
  try {
    await call('config.setCompany', { company });
    setStatus(`Przełączono na firmę ${company}.`, 'ok');
  } catch (e) {
    setStatus(messageFor(e), 'error');
  }
}

/**
 * Wires the settings screen.
 *
 * Call: `mountSettings(call, back)` once; `back` leaves the screen.
 * Expects: main.html settings markup.
 * Output: a handle to load the data and show the folder.
 */
export function mountSettings(call: Call, back: () => void): SettingsScreen {
  const folder = byId('work-folder');
  byId('pick-folder').addEventListener('click', () => void changeFolder(call, folder));
  byId<HTMLSelectElement>('company-select').addEventListener('change', (ev) => {
    void changeCompany(call, (ev.target as HTMLSelectElement).value);
  });
  byId('change-account').addEventListener('click', () => {
    call('session.logout', {}).catch((e) => setStatus(messageFor(e), 'error'));
  });
  byId('settings-back').addEventListener('click', back);
  return {
    async load() {
      const account = await call('account.get', {});
      renderAccount(account);
      renderCompany(account);
    },
    showFolder(path) {
      setPath(folder, path);
    },
  };
}
