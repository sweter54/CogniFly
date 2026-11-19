// "Pliki" screen: Heartwood spaces, conflicts, skipped files and the
// version history of one file. Paths, names and reasons come from the
// daemon: they are data and go into the page via textContent only.
import { fileErrorText, filesViewModel, parseTopics, spaceStatusText, versionLine, type FilesModel, type SpaceRow } from '../../logic/files-view.js';
import type { FilesView, HwConflict, HwIssue, HwSkipped, HwVersion } from '../../logic/heartwood.js';
import { RpcError } from '../../logic/rpc.js';
import { armed, byId, DAEMON_WAIT_MS, formValues, PICKER_WAIT_MS, prime, setBusy, setStatus, takePrimed, type Call } from '../ui.js';

/** Handle returned by `mountFiles`. */
export interface FilesScreen {
  /** Draws the files part of a view (skipped when nothing changed). */
  render(files: FilesView): void;
  /** Draws and starts refreshing every 15 s (screen shown). */
  show(files: FilesView): void;
  /** Stops refreshing (screen left). */
  hide(): void;
}

/** Status line text with its kind. */
type Said = { text: string; kind: 'info' | 'ok' | 'error' };

/** How often the open screen asks for a fresh status. */
const REFRESH_MS = 15_000;
/** Question asked when unselecting would delete the local folder. */
const UNSELECT_QUESTION = 'Usunąć folder z dysku? Pliki zostają na serwerze.';

/**
 * Builds an element with text.
 *
 * Call: `el('span', text, 'muted')`.
 * Expects: a tag name; text is data (set via `textContent`).
 * Output: the element.
 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/**
 * Builds one list row from its parts.
 *
 * Call: `row(el('strong', path), el('span', note))`.
 * Expects: nodes in display order.
 * Output: the `<li>`.
 */
function row(...parts: Node[]): HTMLLIElement {
  const li = document.createElement('li');
  li.append(...parts);
  return li;
}

/**
 * Runs a file action from a button and shows its outcome.
 *
 * Call: `await runAction(button, action)`.
 * Expects: an action resolving to the text to show.
 * Output: none; the button is disabled meanwhile; errors become
 * `hwMessage` texts.
 */
async function runAction(button: HTMLButtonElement, action: () => Promise<Said>): Promise<void> {
  button.disabled = true;
  try {
    const said = await action();
    setStatus(said.text, said.kind);
  } catch (e) {
    setStatus(fileErrorText(e), 'error');
  } finally {
    button.disabled = false;
  }
}

/**
 * Unselects a space; asks before the daemon deletes the folder.
 *
 * Call: `await unselect(call, button, space)` on "Odznacz".
 * Expects: a space id.
 * Output: the outcome; on `CONFIRM` the button asks the question and
 * a second click within 5 s sends `yes: true`. `UNSENT` and other
 * refusals throw (shown as the daemon's text).
 */
async function unselect(call: Call, button: HTMLButtonElement, space: string): Promise<Said> {
  const yes = takePrimed(button);
  try {
    await call('files.unselect', { space, yes }, DAEMON_WAIT_MS);
    return { text: 'Odznaczono przestrzeń.', kind: 'ok' };
  } catch (e) {
    if (yes || !(e instanceof RpcError) || e.code !== 'CONFIRM') throw e;
    prime(button, UNSELECT_QUESTION);
    return { text: UNSELECT_QUESTION, kind: 'info' };
  }
}

/**
 * Row of one selected space.
 *
 * Call: `spaceRow(call, space)`.
 * Expects: a row of the view model.
 * Output: folder, space id, sync state and "Odznacz".
 */
function spaceRow(call: Call, space: SpaceRow): HTMLLIElement {
  const button = el('button', 'Odznacz', 'secondary');
  button.type = 'button';
  button.addEventListener('click', () => void runAction(button, () => unselect(call, button, space.label)));
  return row(el('strong', space.folder), el('span', space.label, 'muted'), el('span', spaceStatusText(space), 'state'), button);
}

/**
 * Row of one conflict.
 * Call: `conflictRow(c)`. Expects: a conflict.
 * Output: path, "Kopia: <copyPath>" and the daemon's message.
 */
function conflictRow(c: HwConflict): HTMLLIElement {
  return row(el('strong', c.path, 'path'), el('span', `Kopia: ${c.copyPath}`, 'path'), el('span', c.message, 'muted'));
}

/**
 * Row of one skipped file.
 * Call: `skippedRow(s)`. Expects: a skipped file.
 * Output: path, reason and the suggested name (or the hint).
 */
function skippedRow(s: HwSkipped): HTMLLIElement {
  const li = row(el('strong', s.path, 'path'), el('span', s.reasonText));
  const tip = s.suggestion ? `Propozycja: ${s.suggestion}` : s.hint;
  if (tip) li.append(el('span', tip, 'muted'));
  return li;
}

/**
 * Row of one current problem.
 * Call: `issueRow(i)`. Expects: an issue (`space` empty = general).
 * Output: the message, prefixed with the space when there is one.
 */
function issueRow(i: HwIssue): HTMLLIElement {
  return row(el('span', i.space ? `${i.space}: ${i.message}` : i.message));
}

/**
 * Fills a list and hides it (and its title) when empty.
 *
 * Call: `fillList('files-conflicts', 'conflicts-title', rows)`.
 * Expects: ids of a list and of its title (`null` = no title).
 * Output: none.
 */
function fillList(listId: string, titleId: string | null, rows: HTMLLIElement[]): void {
  byId(listId).replaceChildren(...rows);
  byId(listId).hidden = rows.length === 0;
  if (titleId) byId(titleId).hidden = rows.length === 0;
}

/**
 * Draws the model (everything except the history).
 *
 * Call: `draw(call, model)`.
 * Expects: main.html files markup.
 * Output: none.
 */
function draw(call: Call, model: FilesModel): void {
  const banner = byId('files-banner');
  banner.hidden = model.banner === null;
  banner.textContent = model.banner ?? '';
  byId('files-body').hidden = !model.ready;
  fillList('files-issues', null, model.issues.map(issueRow));
  byId('files-spaces').replaceChildren(...model.spaces.map((s) => spaceRow(call, s)));
  fillList('files-conflicts', 'conflicts-title', model.conflicts.map(conflictRow));
  fillList('files-skipped', 'skipped-title', model.skipped.map(skippedRow));
}

/**
 * Wires the "Wybierz przestrzeń…" form.
 *
 * Call: `wireSelect(call)` once.
 * Expects: `#space-open`, `#space-form`, `#space-cancel`.
 * Output: none; sending selects the space with optional topics.
 */
function wireSelect(call: Call): void {
  const form = byId<HTMLFormElement>('space-form');
  const open = byId<HTMLButtonElement>('space-open');
  const toggle = (show: boolean) => {
    form.hidden = !show;
    open.hidden = show;
    if (show) form.querySelector<HTMLInputElement>('[name=space]')?.focus();
    else form.reset();
  };
  open.addEventListener('click', () => toggle(true));
  byId('space-cancel').addEventListener('click', () => toggle(false));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { space = '', topics = '' } = formValues(form);
    if (!space.trim()) return;
    setBusy(form, true);
    call('files.select', { space: space.trim(), topics: parseTopics(topics) }, DAEMON_WAIT_MS)
      .then(() => {
        toggle(false);
        setStatus('Wybrano przestrzeń.', 'ok');
      })
      .catch((err) => setStatus(fileErrorText(err), 'error'))
      .finally(() => setBusy(form, false));
  });
}

/**
 * Row of one version with "Pobierz kopię" and "Przywróć".
 *
 * Call: `versionRow(call, path, version, reload)`.
 * Expects: the file path; `reload` shows the history again.
 * Output: the `<li>`; restoring asks twice and needs a file lock.
 */
function versionRow(call: Call, path: string, v: HwVersion, reload: () => Promise<void>): HTMLLIElement {
  const download = el('button', 'Pobierz kopię', 'secondary');
  const restore = el('button', 'Przywróć', 'secondary');
  download.type = restore.type = 'button';
  download.addEventListener('click', () => void runAction(download, async () => {
    const { copy } = await call('files.download', { path, version: v.seq }, DAEMON_WAIT_MS);
    return { text: `Zapisano kopię: ${copy}`, kind: 'ok' };
  }));
  armed(restore, `Przywrócić wersję ${v.seq}? Potrzebna blokada pliku.`, () => runAction(restore, async () => {
    await call('files.restore', { path, version: v.seq }, DAEMON_WAIT_MS);
    void reload();
    return { text: `Przywrócono wersję ${v.seq}.`, kind: 'ok' };
  }));
  return row(el('span', versionLine(v)), download, restore);
}

/**
 * Loads and draws the history of one file.
 *
 * Call: `await showHistory(call, path)`.
 * Expects: a path under the Heartwood root.
 * Output: none; the newest version first.
 * Throws: `RpcError` from `files.history`.
 */
async function showHistory(call: Call, path: string): Promise<void> {
  const { versions } = await call('files.history', { path });
  const reload = () => showHistory(call, path).catch((e) => setStatus(fileErrorText(e), 'error'));
  byId('history-path').textContent = versions.length ? path : `${path} — brak wersji.`;
  const newest = [...versions].sort((a, b) => b.seq - a.seq);
  byId('files-versions').replaceChildren(...newest.map((v) => versionRow(call, path, v, reload)));
}

/**
 * Wires "Wybierz plik…" of the history.
 *
 * Call: `wireHistory(call)` once.
 * Expects: `#history-pick`.
 * Output: none; the file dialog waits up to 10 minutes.
 */
function wireHistory(call: Call): void {
  const pick = byId<HTMLButtonElement>('history-pick');
  pick.addEventListener('click', () => void runAction(pick, async () => {
    const { path } = await call('files.pickPath', {}, PICKER_WAIT_MS);
    if (path !== null) await showHistory(call, path);
    return { text: '', kind: 'info' };
  }));
}

/**
 * Wires the "Pliki" screen.
 *
 * Call: `mountFiles(call)` once at window start.
 * Expects: main.html files markup.
 * Output: a handle to draw views and start/stop refreshing.
 */
export function mountFiles(call: Call): FilesScreen {
  let drawn = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Draws a view when its model changed (keeps open questions).
   * Call: `render(files)`. Expects: the files part of a view.
   * Output: none.
   */
  function render(files: FilesView): void {
    const model = filesViewModel(files);
    const key = JSON.stringify(model);
    if (key === drawn) return;
    drawn = key;
    draw(call, model);
  }

  /**
   * Asks for a fresh status and draws it.
   * Call: `refresh()`. Expects: nothing.
   * Output: none; skipped while the window is hidden.
   */
  function refresh(): void {
    if (document.hidden) return;
    call('files.refresh', {}).then(render).catch((e) => setStatus(fileErrorText(e), 'error'));
  }

  wireSelect(call);
  wireHistory(call);
  byId('files-refresh').addEventListener('click', refresh);
  return {
    render,
    show(files) {
      render(files);
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
    },
    hide() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
