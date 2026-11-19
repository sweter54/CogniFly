// "Pliki" screen: the space browser, Heartwood spaces, untracked
// files, conflicts, skipped files and the version history of one
// file. Paths, names and reasons come from the daemon: they are data
// and go into the page via textContent only.
import {
  adoptErrorText, conflictKey, fileErrorText, filesViewModel, lockableTasks, parseTopics, spaceStatusText, versionLine, type ConflictRow, type FilesModel,
  type SpaceRow, type TaskRef, type UntrackedRow,
} from '../../logic/files-view.js';
import type { FilesView, HwIssue, HwSkipped, HwVersion } from '../../logic/heartwood.js';
import { RpcError } from '../../logic/rpc.js';
import type { InboxView } from '../protocol.js';
import {
  armed, button, byId, DAEMON_WAIT_MS, el, flasher, formValues, pathEl, PICKER_WAIT_MS, prime, row, runFileAction, setBusy, setStatus, takePrimed,
  type Call, type Said,
} from '../ui.js';
import { mountTree } from './files-tree.js';

/** Handle returned by `mountFiles`. */
export interface FilesScreen {
  /** Draws a view: lists (skipped when unchanged) and the browser. */
  render(view: InboxView): void;
  /** Draws and starts refreshing every 15 s (screen shown). */
  show(view: InboxView): void;
  /** Stops refreshing (screen left). */
  hide(): void;
  /** Scrolls to a conflict (`conflictKey`) and makes it flash. */
  highlight(key: string): void;
}

/** Where a history points: a local path or a path in a space. */
type HistoryTarget = { path: string; space?: string };

/** What the rows of the lists need besides their data. */
interface ListContext {
  call: Call;
  /** Tasks the user may move files into (read on click). */
  tasks: () => TaskRef[];
  /** Asks for a fresh status after a change. */
  changed: () => void;
  /** Redraws the lists from the last model (after a picker closes). */
  redraw: () => void;
}

/** How often the open screen asks for a fresh status. */
const REFRESH_MS = 15_000;
/** Shown when the user has no task to move a file into. */
const NO_ADOPT_TASKS = 'Nie masz zadania, do którego można dołączyć plik.';
/** Question asked before the copies of a conflict are deleted. */
const RESOLVE_QUESTION = 'Usunąć kopie konfliktu? Upewnij się, że przepisałeś zmiany.';
/** Question asked when unselecting would delete the local folder. */
const UNSELECT_QUESTION = 'Usunąć folder z dysku? Pliki zostają na serwerze.';

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
  const unsel = button('Odznacz', 'secondary');
  unsel.addEventListener('click', () => void runFileAction(unsel, () => unselect(call, unsel, space.label)));
  return row(pathEl('strong', space.folder), el('span', space.label, 'muted'), el('span', spaceStatusText(space), 'state'), unsel);
}

/**
 * Row of one untracked file.
 * Call: `untrackedRow(ctx, u)`. Expects: a row of the model.
 * Output: path, reason and "Przenieś do zadania…".
 */
function untrackedRow(ctx: ListContext, u: UntrackedRow): HTMLLIElement {
  return row(pathEl('strong', u.label), el('span', u.reasonText, 'muted'), adoptButton(ctx, u));
}

/**
 * "Przenieś do zadania…": shows the user's tasks to pick from.
 * Call: `adoptButton(ctx, row)`. Expects: an untracked file.
 * Output: the button; without tasks it says so, else it turns
 * into a task select and picking a task moves the file.
 */
function adoptButton(ctx: ListContext, u: UntrackedRow): HTMLButtonElement {
  const move = button('Przenieś do zadania…', 'secondary');
  move.addEventListener('click', () => {
    const tasks = ctx.tasks();
    if (!tasks.length) return setStatus(NO_ADOPT_TASKS, 'info');
    const pick = el('select', '', 'task-pick');
    pick.setAttribute('aria-label', 'Zadanie');
    pick.append(new Option('Wybierz zadanie…', ''), ...tasks.map((t) => new Option(t.title, t.id)));
    pick.addEventListener('change', () => {
      if (pick.value) void adopt(ctx, pick, move, u.path);
    });
    // Nothing picked: give the button back (unless adopt did).
    const cancel = () => {
      if (pick.value || !pick.isConnected) return;
      pick.replaceWith(move);
      ctx.redraw();
    };
    pick.addEventListener('blur', cancel);
    pick.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel();
    });
    move.replaceWith(pick);
    pick.focus();
  });
  return move;
}

/**
 * Moves an untracked file into the picked task.
 * Call: `await adopt(ctx, select, button, path)`.
 * Expects: the task select shown in place of `button`.
 * Output: none; the select is disabled during the call, then the
 * button comes back; success asks for a fresh status.
 */
async function adopt(ctx: ListContext, pick: HTMLSelectElement, move: HTMLButtonElement, path: string): Promise<void> {
  pick.disabled = true;
  try {
    await ctx.call('files.adopt', { paths: [path], taskId: pick.value }, DAEMON_WAIT_MS);
    setStatus('Przeniesiono do zadania.', 'ok');
    ctx.changed();
  } catch (e) {
    setStatus(adoptErrorText(e), 'error');
  } finally {
    pick.replaceWith(move);
    ctx.redraw();
  }
}

/**
 * Row of one conflicting file (its conflicts grouped).
 * Call: `conflictRow(ctx, c)`. Expects: a row of the model.
 * Output: path, "N kopii", "Pokaż kopię" (when a copy is left)
 * and "Oznacz jako rozwiązane" (asks, then clears every copy);
 * `data-key` holds its `conflictKey` (tray highlight).
 */
function conflictRow(ctx: ListContext, c: ConflictRow): HTMLLIElement {
  const li = row(pathEl('strong', c.label), el('span', c.countText, 'state'));
  li.dataset.key = conflictKey(c.space, c.path);
  if (c.copyPath) li.append(showCopyButton(ctx.call, c.copyPath));
  const done = button('Oznacz jako rozwiązane', 'secondary');
  armed(done, RESOLVE_QUESTION, () => runFileAction(done, async () => {
    await ctx.call('files.resolve', { space: c.space, path: c.path }, DAEMON_WAIT_MS);
    ctx.changed();
    return { text: 'Oznaczono jako rozwiązane.', kind: 'ok' };
  }));
  li.append(done);
  return li;
}

/**
 * "Pokaż kopię": selects the newest copy in Finder.
 * Call: `showCopyButton(call, copyPath)`. Expects: a copy path.
 * Output: the button.
 */
function showCopyButton(call: Call, copyPath: string): HTMLButtonElement {
  const show = button('Pokaż kopię', 'secondary');
  show.addEventListener('click', () => void runFileAction(show, async () => {
    await call('files.revealCopy', { copyPath });
    return { text: '', kind: 'info' };
  }));
  return show;
}

/**
 * Row of one skipped file.
 * Call: `skippedRow(s)`. Expects: a skipped file.
 * Output: path, reason and the suggested name (or the hint).
 */
function skippedRow(s: HwSkipped): HTMLLIElement {
  const li = row(pathEl('strong', s.path), el('span', s.reasonText));
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
 * Call: `draw(ctx, model)`.
 * Expects: main.html files markup.
 * Output: none.
 */
function draw(ctx: ListContext, model: FilesModel): void {
  const banner = byId('files-banner');
  banner.hidden = model.banner === null;
  banner.textContent = model.banner ?? '';
  byId('files-body').hidden = !model.ready;
  fillList('files-issues', null, model.issues.map(issueRow));
  byId('files-spaces').replaceChildren(...model.spaces.map((s) => spaceRow(ctx.call, s)));
  // An open task picker keeps its list; the others redraw anyway.
  if (!document.querySelector('#files-untracked select')) {
    fillList('files-untracked', 'untracked-title', model.untracked.map((u) => untrackedRow(ctx, u)));
  }
  fillList('files-conflicts', 'conflicts-title', model.conflicts.map((c) => conflictRow(ctx, c)));
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
 * Call: `versionRow(call, target, version, reload)`.
 * Expects: the file; `reload` shows the history again.
 * Output: the `<li>`; "Przywróć" (asks twice, needs a file lock)
 * only for a local path: the daemon restores local files only.
 */
function versionRow(call: Call, target: HistoryTarget, v: HwVersion, reload: () => Promise<void>): HTMLLIElement {
  const download = button('Pobierz kopię', 'secondary');
  download.addEventListener('click', () => void runFileAction(download, async () => {
    const { copy } = await call('files.download', { ...target, version: v.seq }, DAEMON_WAIT_MS);
    return { text: `Zapisano kopię: ${copy}`, kind: 'ok' };
  }));
  const li = row(el('span', versionLine(v)), download);
  if (target.space !== undefined) return li;
  const restore = button('Przywróć', 'secondary');
  armed(restore, `Przywrócić wersję ${v.seq}? Potrzebna blokada pliku.`, () => runFileAction(restore, async () => {
    await call('files.restore', { path: target.path, version: v.seq }, DAEMON_WAIT_MS);
    void reload();
    return { text: `Przywrócono wersję ${v.seq}.`, kind: 'ok' };
  }));
  li.append(restore);
  return li;
}

/**
 * Loads and draws the history of one file.
 *
 * Call: `await showHistory(call, { path })` or
 * `showHistory(call, { space, path })`.
 * Expects: a path under the Heartwood root, or a path in a space.
 * Output: none; the newest version first; the title names the
 * space for a space path.
 * Throws: `RpcError` from `files.history`.
 */
async function showHistory(call: Call, target: HistoryTarget): Promise<void> {
  const { versions } = await call('files.history', target);
  const reload = () => showHistory(call, target).catch((e) => setStatus(fileErrorText(e), 'error'));
  const name = target.space === undefined ? target.path : `${target.space}: ${target.path}`;
  byId('history-path').replaceChildren(pathEl('strong', name), ...(versions.length ? [] : [el('span', '— brak wersji.')]));
  const newest = [...versions].sort((a, b) => b.seq - a.seq);
  byId('files-versions').replaceChildren(...newest.map((v) => versionRow(call, target, v, reload)));
  byId('history-path').scrollIntoView({ block: 'nearest' });
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
  pick.addEventListener('click', () => void runFileAction(pick, async () => {
    const { path } = await call('files.pickPath', {}, PICKER_WAIT_MS);
    if (path !== null) await showHistory(call, { path });
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
  let view: InboxView | null = null;
  const ctx: ListContext = {
    call,
    tasks: () => (view ? lockableTasks(view.tasks, view.osoba, view.files.info.state) : []),
    changed: () => refresh(false),
    redraw: () => {
      drawn = '';
      if (view) renderFiles(view.files);
    },
  };
  const flash = flasher(conflictElement, '#files-conflicts li.flash');
  const tree = mountTree(call, (space, path) => {
    showHistory(call, { space, path }).catch((e) => setStatus(fileErrorText(e), 'error'));
  });

  /**
   * Draws the files part when its model changed (keeps open
   * questions; an open task select of "Nieśledzone" keeps its list).
   * Call: `renderFiles(files)`. Expects: the files part of a view.
   * Output: none; a requested conflict highlight is re-applied.
   */
  function renderFiles(files: FilesView): void {
    if (view) view = { ...view, files };
    const model = filesViewModel(files);
    const key = JSON.stringify(model);
    if (key !== drawn) {
      drawn = key;
      draw(ctx, model);
    }
    flash.apply();
  }

  /**
   * Draws a view: the lists and the browser.
   * Call: `render(view)`. Expects: a logged-in view.
   * Output: none.
   */
  function render(next: InboxView): void {
    view = next;
    renderFiles(next.files);
    tree.render(next);
  }

  /**
   * Asks for a fresh status and folder level and draws them.
   * Call: `refresh(manual)`; `manual` = the user clicked „Odśwież”.
   * Expects: nothing.
   * Output: none; errors are shown only for a manual refresh (the
   * banner covers the periodic one); periodic ones are skipped while
   * the window is hidden.
   */
  function refresh(manual: boolean): void {
    if (!manual && document.hidden) return;
    call('files.refresh', {}).then((files) => {
      renderFiles(files);
      tree.setFiles(files);
    }).catch((e) => {
      if (manual) setStatus(fileErrorText(e), 'error');
    });
    tree.reload(manual);
  }

  wireSelect(call);
  wireHistory(call);
  byId('files-refresh').addEventListener('click', () => refresh(true));
  return {
    render,
    show(view) {
      render(view);
      tree.reload(false);
      clearInterval(timer);
      timer = setInterval(() => refresh(false), REFRESH_MS);
    },
    hide() {
      clearInterval(timer);
      timer = undefined;
    },
    highlight(key) {
      if (!flash.request(key)) refresh(false);
    },
  };
}

/**
 * Finds the row of a conflicting file.
 *
 * Call: `conflictElement(conflictKey(space, path))`.
 * Expects: a key of `conflictKey`.
 * Output: the `<li>` of "Konflikty", or undefined when not listed.
 */
function conflictElement(key: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('#files-conflicts li')).find((li) => li.dataset.key === key);
}
