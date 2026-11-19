// Space browser of the "Pliki" screen: one folder level of a space with
// lock states, task links and actions. Names, paths and writers come
// from the daemon: they are data and go into the page via textContent.
import {
  fileErrorText, folderCrumbs, lockableTasks, spaceChoices, taskRefs, treeViewModel, visibleRows, type TreeRow,
} from '../../logic/files-view.js';
import type { FilesView, HwBrowse } from '../../logic/heartwood.js';
import type { InboxView } from '../protocol.js';
import { button, byId, DAEMON_WAIT_MS, el, messageFor, row, runFileAction, setStatus, type Call } from '../ui.js';

/** Handle returned by `mountTree`. */
export interface SpaceTree {
  /** Remembers a view (tasks, spaces) and redraws when it changed. */
  render(view: InboxView): void;
  /** Remembers a fresh files part of the view. */
  setFiles(files: FilesView): void;
  /** Reads the shown level again (`manual` shows errors). */
  reload(manual: boolean): void;
}

/** Opens a file's history (space id and path in the space). */
export type ShowHistory = (space: string, path: string) => void;

/** How long `files.tree` may take (the daemon waits up to 30 s). */
const TREE_WAIT_MS = 40_000;
/** Shown when a level has no rows. */
const EMPTY = 'Ten folder jest pusty.';
/** Shown when "Tylko zablokowane" hides every row. */
const EMPTY_LOCKED = 'Brak zablokowanych plików w tym folderze.';
/** Shown when the user has no task to lock files for. */
const NO_TASKS = 'Nie masz zadania, do którego możesz zablokować pliki.';

/**
 * Wires the space browser.
 *
 * Call: `mountTree(call, showHistory)` once (from `mountFiles`).
 * Expects: main.html tree markup (`#tree-*`).
 * Output: a handle; the first selected space opens by itself.
 */
export function mountTree(call: Call, showHistory: ShowHistory): SpaceTree {
  let view: InboxView | null = null;
  let target: { space: string; folder: string } | null = null;
  let level: HwBrowse | null = null;
  let seq = 0;
  let loading = false;
  let drawn = '';
  let choices = '';

  /**
   * Reads a folder level; a reply for an older request is dropped.
   * Call: `load(manual)`. Expects: a target.
   * Output: none; errors show only when `manual`, and then the
   * last shown level (if any) stays the target.
   */
  function load(manual: boolean): void {
    if (!target) return;
    const mine = ++seq;
    loading = true;
    call('files.tree', { space: target.space, folder: target.folder }, TREE_WAIT_MS).then((r) => {
      if (mine !== seq) return;
      level = r;
      target = { space: r.space, folder: r.folder };
      syncSelect();
      draw();
    }).catch((e) => {
      if (mine !== seq || !manual) return;
      setStatus(fileErrorText(e), 'error');
      target = level ? { space: level.space, folder: level.folder } : null;
      syncSelect();
    }).finally(() => {
      if (mine === seq) loading = false;
    });
  }

  /**
   * Opens a folder of a space.
   * Call: `open(space, folder)`; `manual = false` for the first
   * space opened by itself (errors are not shown, retried later).
   * Expects: `''` = the space root.
   * Output: none; the new level replaces the old when it comes.
   */
  function open(space: string, folder: string, manual = true): void {
    target = { space, folder };
    syncSelect();
    load(manual);
  }

  /**
   * Fills the space select (selected spaces, the typed one, "Inna").
   * Call: `syncSelect()` after the spaces or the target changed.
   * Expects: a view. Output: none; rebuilt only when it changed.
   */
  function syncSelect(): void {
    const ids = view ? spaceChoices(view.files) : [];
    if (target && !ids.includes(target.space)) ids.push(target.space);
    const key = JSON.stringify([ids, target?.space]);
    if (key === choices) return;
    choices = key;
    const select = byId<HTMLSelectElement>('tree-space');
    const other = new Option('Inna przestrzeń…', '');
    other.dataset.other = 'true';
    select.replaceChildren(...(target ? [] : [new Option('Wybierz przestrzeń…', '')]), ...ids.map((id) => new Option(id, id)), other);
    select.value = target?.space ?? '';
    if (!target) select.selectedIndex = 0;
  }

  /**
   * Draws the level when it, the filter or the tasks changed.
   * Call: `draw(force?)`. Expects: a loaded level.
   * Output: none; an open task select survives unchanged levels.
   */
  function draw(force = false): void {
    const b = level;
    if (!b || !view) return;
    const onlyLocked = byId<HTMLInputElement>('tree-locked').checked;
    const key = JSON.stringify([b, onlyLocked, view.tasks, view.osoba, view.files.info.state]);
    if (key === drawn && !force) return;
    drawn = key;
    const model = treeViewModel(b, taskRefs(view.tasks));
    const rows = visibleRows(model.rows, onlyLocked);
    drawCrumbs(b);
    byId('tree-reveal').hidden = !model.canOpenFolder;
    byId('tree-rows').replaceChildren(...rows.map((r) => treeRow(r, b)));
    const note = byId('tree-note');
    note.hidden = rows.length > 0;
    note.textContent = onlyLocked ? EMPTY_LOCKED : EMPTY;
  }

  /**
   * Draws the folder path; every step but the last opens its folder.
   * Call: `drawCrumbs(level)`. Expects: a loaded level.
   * Output: none.
   */
  function drawCrumbs(b: HwBrowse): void {
    const crumbs = folderCrumbs(b.space, b.folder);
    const nodes = crumbs.flatMap((c, i) => {
      const sep = i ? [el('span', '/', 'muted')] : [];
      if (i === crumbs.length - 1) return [...sep, el('strong', c.label)];
      const go = button(c.label, 'link');
      go.addEventListener('click', () => open(b.space, c.folder));
      return [...sep, go];
    });
    byId('tree-crumbs').replaceChildren(...nodes);
  }

  /**
   * One row of the level with its actions.
   * Call: `treeRow(row, level)`. Expects: a row of the model.
   * Output: the `<li>`; a folder name opens the folder.
   */
  function treeRow(r: TreeRow, b: HwBrowse): HTMLLIElement {
    const name = r.folder ? button(`${r.name}/`, 'link path') : el('strong', r.name, 'path');
    if (r.folder) name.addEventListener('click', () => open(b.space, r.path));
    const li = row(name, el('span', r.stateText, 'state'));
    if (r.taskLink) li.append(taskLinkButton(r.taskLink));
    li.append(el('span', '', 'spacer'));
    for (const a of r.actions) {
      if (a === 'lock') li.append(lockButton(r, b));
      if (a === 'requestRelease') li.append(requestButton(r, b));
      if (a === 'history') li.append(historyButton(r, b));
      if (a === 'open' && r.folder) li.append(revealButton(b.space, r.path));
    }
    return li;
  }

  /**
   * Link to the task that holds a lock.
   * Call: `taskLinkButton(link)`. Expects: a checked task id.
   * Output: a button that shows the task in the inbox.
   */
  function taskLinkButton(link: { taskId: string; title: string }): HTMLButtonElement {
    const b = button(`Zadanie: ${link.title}`, 'link task-link');
    b.addEventListener('click', () => {
      call('task.focus', { id: link.taskId }).catch((e) => setStatus(messageFor(e), 'error'));
    });
    return b;
  }

  /**
   * "Zablokuj do zadania…": shows the user's tasks to pick from.
   * Call: `lockButton(row, level)`. Expects: a free entry.
   * Output: the button; picking a task locks the entry (a folder
   * as a folder lock) and reads the level again.
   */
  function lockButton(r: TreeRow, b: HwBrowse): HTMLButtonElement {
    const lock = button('Zablokuj do zadania…', 'secondary');
    lock.addEventListener('click', () => {
      const tasks = view ? lockableTasks(view.tasks, view.osoba, view.files.info.state) : [];
      if (!tasks.length) return setStatus(NO_TASKS, 'info');
      const pick = el('select', '', 'task-pick');
      pick.setAttribute('aria-label', 'Zadanie');
      pick.append(new Option('Wybierz zadanie…', ''), ...tasks.map((t) => new Option(t.title, t.id)));
      pick.addEventListener('change', () => {
        if (!pick.value) return;
        const taskId = pick.value;
        void runFileAction(lock, async () => {
          await call('files.lockFor', { taskId, space: b.space, path: r.path, ...(r.folder ? { folder: true } : {}) }, DAEMON_WAIT_MS);
          load(false);
          return { text: 'Zablokowano do zadania.', kind: 'ok' };
        });
      });
      lock.replaceWith(pick);
      pick.focus();
    });
    return lock;
  }

  /**
   * "Poproś o zwolnienie" of an entry locked by someone else.
   * Call: `requestButton(row, level)`. Expects: a locked entry.
   * Output: the button.
   */
  function requestButton(r: TreeRow, b: HwBrowse): HTMLButtonElement {
    const ask = button('Poproś o zwolnienie', 'secondary');
    ask.addEventListener('click', () => void runFileAction(ask, async () => {
      await call('files.requestRelease', { space: b.space, path: r.path }, DAEMON_WAIT_MS);
      return { text: 'Wysłano prośbę o zwolnienie.', kind: 'ok' };
    }));
    return ask;
  }

  /**
   * "Historia" of a file.
   * Call: `historyButton(row, level)`. Expects: a file entry.
   * Output: the button; the history shows below the lists.
   */
  function historyButton(r: TreeRow, b: HwBrowse): HTMLButtonElement {
    const history = button('Historia', 'secondary');
    history.addEventListener('click', () => showHistory(b.space, r.path));
    return history;
  }

  /**
   * "Otwórz w Finderze" for a folder of a space.
   * Call: `revealButton(space, folder)`. Expects: a local folder
   * (`''` = the space root).
   * Output: the button.
   */
  function revealButton(space: string, folder: string): HTMLButtonElement {
    const reveal = button('Otwórz w Finderze', 'secondary');
    reveal.addEventListener('click', () => void revealFrom(reveal, space, folder));
    return reveal;
  }

  /**
   * Opens a folder of a space in Finder from a button.
   * Call: `await revealFrom(button, space, folder)`.
   * Expects: a local folder. Output: none; refusals are shown.
   */
  function revealFrom(b: HTMLButtonElement, space: string, folder: string): Promise<void> {
    return runFileAction(b, async () => {
      await call('files.reveal', { space, folder });
      return { text: '', kind: 'info' };
    });
  }

  /**
   * Wires the space select, the other-space form, the filter and
   * the level's "Otwórz w Finderze".
   * Call: once. Expects: main.html tree markup. Output: none.
   */
  function wire(): void {
    const select = byId<HTMLSelectElement>('tree-space');
    const form = byId<HTMLFormElement>('tree-other');
    const input = form.querySelector('input') as HTMLInputElement;
    const showForm = (show: boolean) => {
      form.hidden = !show;
      if (show) input.focus();
      else form.reset();
    };
    select.addEventListener('change', () => {
      if (select.selectedOptions[0]?.dataset.other) return showForm(true);
      showForm(false);
      if (select.value) open(select.value, '');
    });
    byId('tree-other-cancel').addEventListener('click', () => {
      showForm(false);
      select.value = target?.space ?? '';
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const space = input.value.trim();
      if (!space) return;
      showForm(false);
      open(space, '');
    });
    byId('tree-locked').addEventListener('change', () => draw(true));
    const reveal = byId<HTMLButtonElement>('tree-reveal');
    reveal.addEventListener('click', () => {
      if (level) void revealFrom(reveal, level.space, level.folder);
    });
  }

  wire();
  return {
    render(next) {
      view = next;
      syncSelect();
      const first = spaceChoices(next.files)[0];
      if (!target && first) open(first, '', false);
      else draw();
    },
    setFiles(files) {
      if (view) view = { ...view, files };
      syncSelect();
    },
    reload(manual) {
      if (!manual && (loading || document.querySelector('#tree-rows select'))) return;
      load(manual);
    },
  };
}
