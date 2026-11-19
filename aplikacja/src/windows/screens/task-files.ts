// "Pliki zadania" under a task of the inbox: locks and changed files
// of the task's Heartwood work. Paths and names come from the daemon:
// they are data and go into the page via textContent only.
import { fileErrorText, taskFilesModel, versionLine, versionsLabel, type ChangeRow, type LockRow, type TaskFilesModel } from '../../logic/files-view.js';
import type { HwState } from '../../logic/heartwood.js';
import { button, DAEMON_WAIT_MS, el, PICKER_WAIT_MS, row, runFileAction, type Call, type Said } from '../ui.js';

/** How often an open section reads the task's files again. */
const REFRESH_MS = 15_000;

/** Tasks whose section is open (kept across redraws of the list). */
const openTasks = new Set<string>();
/** Last drawn model per task (a redraw shows it at once). */
const shown = new Map<string, TaskFilesModel>();
/** Files whose version list is open: `[task, space, path]` JSON. */
const openVersions = new Set<string>();
/** Number of the newest `task.files` request per task. */
const requests = new Map<string, number>();
/** Tasks whose newest `task.files` request has not answered yet. */
const pending = new Set<string>();
/** Timer of the periodic refresh (started with the first section). */
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Finds a control inside a task item.
 * Call: `part(li, '.lock')`. Expects: the task template markup.
 * Output: the element.
 */
function part<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  return root.querySelector(selector) as T;
}

/**
 * Finds the list item that shows a task now.
 * Call: `taskItem(id)`. Expects: a task id.
 * Output: the item, or undefined when the task is not drawn.
 */
function taskItem(taskId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.task')).find((li) => li.dataset.id === taskId);
}

/**
 * Reads the task's files and draws them where the task is shown.
 *
 * Call: `reload(call, id)` on opening and after actions;
 * `reload(call, id, true)` from the timer.
 * Expects: a task id.
 * Output: none; the timer skips a task whose request is still
 * pending (no pile-up); a reply for another task or older than the
 * newest request is dropped; a failure shows its text.
 */
function reload(call: Call, taskId: string, byTimer = false): void {
  if (byTimer && pending.has(taskId)) return;
  const mine = (requests.get(taskId) ?? 0) + 1;
  requests.set(taskId, mine);
  pending.add(taskId);
  call('task.files', { id: taskId }, DAEMON_WAIT_MS).then((r) => {
    if (r.id !== taskId || requests.get(taskId) !== mine) return;
    const model = taskFilesModel(r.files, r.me);
    shown.set(taskId, model);
    const li = taskItem(taskId);
    if (li) draw(li, call, taskId, model);
  }).catch((e) => {
    const li = taskItem(taskId);
    if (requests.get(taskId) === mine && li) showError(li, fileErrorText(e));
  }).finally(() => {
    if (requests.get(taskId) === mine) pending.delete(taskId);
  });
}

/**
 * Shows why the files could not be read.
 * Call: `showError(li, text)`. Expects: a task item.
 * Output: none.
 */
function showError(li: HTMLElement, text: string): void {
  const p = part(li, '.files-error');
  p.textContent = text;
  p.hidden = false;
}

/**
 * Refreshes the open sections that are on screen.
 * Call: by the timer every 15 s. Expects: nothing.
 * Output: none; nothing while the window or the inbox is hidden.
 */
function refreshOpen(call: Call): void {
  if (document.hidden) return;
  for (const taskId of openTasks) {
    const li = taskItem(taskId);
    if (li && !li.closest('[hidden]')) reload(call, taskId, true);
  }
}

/**
 * Runs a file action of a section and reads the files again.
 *
 * Call: `act(button, call, id, action)`.
 * Expects: `action` resolves to the outcome text.
 * Output: none; the files are read again also after a failure
 * (a release may be partial).
 */
function act(b: HTMLButtonElement, call: Call, taskId: string, action: () => Promise<Said>): Promise<void> {
  return runFileAction(b, async () => {
    try {
      return await action();
    } finally {
      reload(call, taskId);
    }
  });
}

/**
 * One lock row; the writer gets "Zwolnij".
 * Call: `lockRow(call, id, lock, canEdit)`. Expects: a model row.
 * Output: the `<li>`.
 */
function lockRow(call: Call, taskId: string, l: LockRow, canEdit: boolean): HTMLLIElement {
  const li = row(el('strong', l.label, 'path'), el('span', `${l.who} · ${l.when}`, 'muted'));
  if (!canEdit) return li;
  const release = button('Zwolnij', 'secondary');
  release.addEventListener('click', () => void act(release, call, taskId, async () => {
    const { paths } = await call('task.releaseFiles', { id: taskId, space: l.space, path: l.path }, DAEMON_WAIT_MS);
    return { text: `Zwolniono pliki: ${paths.length}.`, kind: 'ok' };
  }));
  li.append(release);
  return li;
}

/**
 * One changed file with "Pobierz" and its version list.
 *
 * Call: `changeRow(call, id, change)`. Expects: a model row.
 * Output: the `<li>`; "Pobierz" saves a copy of the newest
 * version; "<n> zapisów" opens the list (kept across redraws).
 */
function changeRow(call: Call, taskId: string, c: ChangeRow): HTMLLIElement {
  const key = JSON.stringify([taskId, c.space, c.path]);
  const download = button('Pobierz', 'secondary');
  download.addEventListener('click', () => void runFileAction(download, async () => {
    const { copy } = await call('files.download', { space: c.space, path: c.path, version: c.latestSeq }, DAEMON_WAIT_MS);
    return { text: `Zapisano kopię: ${copy}`, kind: 'ok' };
  }));
  const toggle = button(versionsLabel(c.count), 'link');
  const list = el('ul', '', 'versions');
  list.append(...c.versions.map((v) => el('li', versionLine(v))));
  list.hidden = !openVersions.has(key);
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    if (list.hidden) openVersions.delete(key);
    else openVersions.add(key);
  });
  const who = el('span', `${c.who} · ${c.when}`, 'muted');
  return row(el('strong', c.label, 'path'), el('span', c.kindText, 'state'), who, toggle, el('span', '', 'spacer'), download, list);
}

/**
 * Draws a model into the section of a task item.
 * Call: `draw(li, call, id, model)`. Expects: the task template.
 * Output: none.
 */
function draw(li: HTMLElement, call: Call, taskId: string, m: TaskFilesModel): void {
  part(li, '.files-error').hidden = true;
  part(li, '.files-lock').hidden = !m.canEdit;
  part(li, '.release-all').hidden = !m.canEdit || m.locks.length === 0;
  part(li, '.file-locks').replaceChildren(...m.locks.map((l) => lockRow(call, taskId, l, m.canEdit)));
  part(li, '.locks-empty').hidden = m.locks.length > 0;
  const note = part(li, '.hidden-note');
  note.hidden = m.hiddenNote === null;
  note.textContent = m.hiddenNote ?? '';
  part(li, '.file-changes').replaceChildren(...m.changes.map((c) => changeRow(call, taskId, c)));
  part(li, '.changes-empty').hidden = m.changes.length > 0;
  part(li, '.closed-note').hidden = !m.closed;
}

/**
 * Wires "Zablokuj pliki…" and "Zwolnij wszystkie" of a section.
 * Call: `wireButtons(li, call, id)` once per task item.
 * Expects: the task template. Output: none.
 */
function wireButtons(li: HTMLElement, call: Call, taskId: string): void {
  const lock = part<HTMLButtonElement>(li, '.files-lock');
  lock.addEventListener('click', () => void act(lock, call, taskId, async () => {
    const { paths } = await call('task.lockFiles', { id: taskId }, PICKER_WAIT_MS);
    return paths.length ? { text: `Zablokowane pliki: ${paths.length}.`, kind: 'ok' } : { text: 'Nie wybrano plików.', kind: 'info' };
  }));
  const releaseAll = part<HTMLButtonElement>(li, '.release-all');
  releaseAll.addEventListener('click', () => void act(releaseAll, call, taskId, async () => {
    const { paths } = await call('task.releaseFiles', { id: taskId }, DAEMON_WAIT_MS);
    return { text: `Zwolniono pliki: ${paths.length}.`, kind: 'ok' };
  }));
}

/**
 * Sets up "Pliki zadania" under a task.
 *
 * Call: `wireFiles(li, task.id, state, call)` for every task item.
 * Expects: the task template; the Heartwood supervisor state.
 * Output: none; shown while Heartwood runs; opening the section
 * reads the files, an open section is read again every 15 s while
 * on screen; an open section and its last data survive redraws.
 */
export function wireFiles(li: HTMLElement, taskId: string, state: HwState, call: Call): void {
  const box = part<HTMLDetailsElement>(li, '.task-files');
  box.hidden = state !== 'running';
  if (box.hidden) return;
  timer ??= setInterval(() => refreshOpen(call), REFRESH_MS);
  wireButtons(li, call, taskId);
  box.open = openTasks.has(taskId);
  const last = shown.get(taskId);
  if (last) draw(li, call, taskId, last);
  box.addEventListener('toggle', () => {
    if (box.open === openTasks.has(taskId)) return; // set by a redraw
    if (!box.open) return void openTasks.delete(taskId);
    openTasks.add(taskId);
    reload(call, taskId);
  });
}
