// Brain of the background window: owns config, session, polling,
// notifications and the rpc handlers. Platform effects are injected
// as ports, so the whole flow is unit-tested without Tauri.
import { TASK_ID_PATTERN, THREAD_PATTERN, type Task, type UserSettableState } from '@cognifly/wspolne/api';
import type { InboxView, Methods, Screen } from '../windows/protocol.js';
import { ApiClient, type Membership } from './api.js';
import { confirmEmailCode, refreshTokens, startEmailLogin, type CognitoContext, type PendingLogin } from './cognito.js';
import { isSafeFolder, loadConfig, saveChoices, type AppConfig, type UserChoices } from './config.js';
import { claudeLink, threadLink } from './claude-link.js';
import { AppError, CognitoError, errorCode, LoginRequiredError } from './errors.js';
import {
  checkReply, DISABLED_INFO, heartwoodRoot, filesView, groupBySpace, hwError, inBatches, isSpacePath, isUnderRoot, locksBySpace, parseBrowse, parseStatus,
  parseVersions, parseWorkFiles, workIdFor, type FilesView, type HeartwoodPort, type HwBrowse, type HwInfo, type HwReply,
  type HwRequest, type HwStatus, type HwWorkFiles,
} from './heartwood.js';
import type { FetchFn } from './http.js';
import { clearSeen, loadSeen, notificationBody, notificationTitle, pickNew, saveSeen, waitingTasks } from './notify.js';
import type { Handler } from './rpc.js';
import { SessionManager, subOf, type Vault } from './session.js';
import type { KeyValueStore } from './storage.js';

/** Poll interval (ms). */
export const POLL_INTERVAL_MS = 60_000;

/** Start refusals that will not change until the app changes. */
const FINAL_START_CODES: readonly string[] = ['DISABLED', 'NOT_INSTALLED', 'BAD_ROOT', 'ROOT_TOO_LONG'];
/** Longest accepted space or topic name (the daemon checks more). */
const MAX_NAME = 200;
/** Most `work-files` pages read for one task (100 versions each). */
const MAX_WORK_PAGES = 20;

/** Platform effects used by the controller. */
export interface Ports {
  store: KeyValueStore;
  vault: Vault;
  fetch: FetchFn;
  /** Heartwood daemon, its local API and the file picker. */
  heartwood: HeartwoodPort;
  /** Shows one system notification. */
  notify(title: string, body: string): Promise<void>;
  /** Updates tray and inbox window with the latest view. */
  render(view: InboxView): void;
  /** Brings the main window to the front on a screen; optionally
   *  highlights one task there. */
  showScreen(screen: Screen, highlightTask?: string): Promise<void>;
  /** Shows the OS folder picker; resolves `null` when cancelled. */
  pickFolder(startAt: string): Promise<string | null>;
  /** Opens a URL with the OS (only `claude://` is allowed by scope). */
  openUrl(url: string): Promise<void>;
  /** Shows (selects) a local item in Finder; never opens or runs
   *  it, so a bundle such as `X.app` is not launched. */
  revealFolder(path: string): Promise<void>;
  /** Writes a diagnostic line (counts and codes only, no task text). */
  log?(line: string): void;
  now?: () => number;
}

/** Background controller. */
export class Controller {
  private config: AppConfig;
  private readonly session: SessionManager;
  private pending: PendingLogin | null = null;
  private polling: Promise<InboxView> | null = null;
  private view: InboxView;
  /** Companies of the logged-in person (from `GET /ja`); null = not loaded. */
  private companies: Membership[] | null = null;
  /** Company + root the daemon was started for; null = not started. */
  private filesOrg: string | null = null;

  /**
   * Call: `new Controller(ports)`.
   * Expects: ports of the running platform.
   * Output: a controller with config loaded; call `start()` next.
   */
  constructor(private readonly ports: Ports) {
    this.config = loadConfig(ports.store);
    this.view = {
      loggedIn: false, offline: false, email: null, osoba: null, tasks: [], updatedAt: null,
      workFolder: this.config.workFolder, files: filesView(DISABLED_INFO, null),
    };
    this.session = new SessionManager(ports.vault, (rt) => refreshTokens(this.cognito(), rt), ports.now);
  }

  /**
   * Starts the app: restores the session and polls once.
   *
   * Call: `await controller.start()` when the background window loads.
   * Expects: nothing.
   * Output: the first view; without a session (or when the keychain
   * refuses access) or without a work folder, the main window opens
   * on the guided setup.
   */
  async start(): Promise<InboxView> {
    let s: Awaited<ReturnType<SessionManager['current']>>;
    try {
      s = await this.session.current();
    } catch (e) {
      this.ports.log?.(`vault read failed: ${errorCode(e)}`);
      s = null;
    }
    this.update({ loggedIn: !!s, email: s?.email ?? null });
    if (!s) {
      await this.ports.showScreen('login');
      return this.view;
    }
    if (!this.config.workFolder) await this.ports.showScreen('login');
    return this.poll();
  }

  /**
   * Polls the inbox once (concurrent calls share one request).
   *
   * Call: `await controller.poll()` from the timer, tray or a window.
   * Expects: nothing; does nothing remote when logged out.
   * Output: the new view. Offline keeps the last tasks and marks
   * `offline`; a revoked session marks logged out and opens login.
   */
  poll(): Promise<InboxView> {
    this.polling ??= this.runPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /**
   * Logs out: clears tokens and the notification memory.
   *
   * Call: `await controller.logout()` from the tray menu.
   * Expects: nothing.
   * Output: none; view becomes logged out and the daemon stops.
   */
  async logout(): Promise<void> {
    await this.session.logout();
    clearSeen(this.ports.store);
    this.pending = null;
    this.companies = null;
    this.update({ loggedIn: false, offline: false, email: null, osoba: null, tasks: [], updatedAt: null });
    await this.stopFiles();
  }

  /**
   * Shows a task after it changed elsewhere (e.g. state set in Claude).
   *
   * Call: `await controller.focusTask(id)` for a `cognifly://` link.
   * Expects: an id already checked by `taskFromAppLink`.
   * Output: none; the inbox is fetched first, then the main window
   * opens on it with the task highlighted. Before setup is finished
   * the setup screen is shown instead.
   */
  async focusTask(id: string): Promise<void> {
    if (!this.view.loggedIn || !this.config.workFolder) {
      await this.ports.showScreen('login');
      return;
    }
    await this.poll();
    await this.ports.showScreen('inbox', id);
  }

  /**
   * Current view (for the tray and windows).
   *
   * Call: `controller.current()`.
   * Expects: nothing.
   * Output: the last rendered view.
   */
  current(): InboxView {
    return this.view;
  }

  /**
   * Rpc handlers served to UI windows.
   *
   * Call: `rpcServer(bus, controller.handlers(), errorCode)`.
   * Expects: params from untrusted-by-default windows; each handler
   * validates its input.
   * Output: one handler per method of `Methods`.
   */
  handlers(): Record<keyof Methods, Handler> {
    return {
      'account.get': async () => ({
        email: this.view.email, osoba: this.view.osoba, company: this.config.company, companies: this.companies ?? [],
      }),
      'config.setCompany': (p) => this.setCompany(text(p, 'company')),
      'login.sendCode': (p) => this.sendCode(text(p, 'email')),
      'login.confirm': (p) => this.confirm(text(p, 'code')),
      'inbox.get': async () => this.view,
      'inbox.refresh': () => this.poll(),
      'inbox.take': (p) => this.take(text(p, 'id')),
      'inbox.setState': (p) => this.change(() => this.api().setState(text(p, 'id'), text(p, 'state') as UserSettableState, optionalText(p, 'acceptor'))),
      'task.accept': (p) => this.change(() => this.api().accept(text(p, 'id'))),
      'task.sendBack': (p) => this.change(() => this.api().sendBack(text(p, 'id'), text(p, 'reason'))),
      'task.openInClaude': (p) => this.openInClaude(text(p, 'id'), field(p, 'newThread') === true),
      'task.reject': (p) => this.change(() => this.api().reject(text(p, 'id'), text(p, 'reason'))),
      'task.remove': (p) => this.change(() => this.api().remove(text(p, 'id'))),
      'task.handOver': (p) => this.change(() => this.api().handOver(text(p, 'id'), text(p, 'person'))),
      'config.pickFolder': (p) => this.pickFolder(text(p, 'current')),
      'config.setWorkFolder': (p) => this.setWorkFolder(text(p, 'path')),
      'people.list': async () => ({ people: await this.api().people() }),
      'review.request': (p) => this.requestReview(p),
      'session.logout': async () => {
        await this.logout();
        return { ok: true };
      },
      ...this.fileHandlers(),
    };
  }

  /**
   * Rpc handlers of the files feature.
   *
   * Call: spread into `handlers()`.
   * Expects: params from the main window; paths are checked against
   * the Heartwood root before reaching the daemon.
   * Output: one handler per `files.*` / `task.*Files` method. Daemon
   * refusals reject with their code (the UI shows `hwMessage`).
   */
  private fileHandlers(): Pick<Record<keyof Methods, Handler>, FileMethod> {
    return {
      'files.get': async () => this.view.files,
      'files.refresh': () => this.refreshFiles(this.session.epoch()),
      'files.history': async (p) => {
        const target = await this.fileTarget(p, true);
        const r = await this.fileAction({ cmd: 'history', ...target });
        return { versions: parseVersions(r.versions), path: target.path };
      },
      'files.download': async (p) => {
        const r = await this.fileAction({ cmd: 'download', ...(await this.fileTarget(p)), version: versionParam(p) });
        if (typeof r.copy !== 'string') throw new AppError('BAD_RESPONSE');
        return { copy: r.copy };
      },
      'files.restore': async (p) => {
        await this.fileAction({ cmd: 'restore', path: await this.underRoot(text(p, 'path')), version: versionParam(p) });
        return { ok: true };
      },
      'files.select': async (p) => {
        await this.fileAction({ cmd: 'select', ...scopeParams(p) });
        return { ok: true };
      },
      'files.unselect': async (p) => {
        await this.fileAction({ cmd: 'unselect', ...scopeParams(p), yes: field(p, 'yes') === true });
        return { ok: true };
      },
      'files.pickPath': () => this.pickPath(),
      'files.tree': async (p) => this.tree(treeParams(p)),
      'files.lockFor': async (p) => {
        const workId = workIdFor(taskIdParam(p, 'taskId'));
        const folder = field(p, 'folder') === true ? { folder: true } : {};
        const { space, path } = spacePathParams(p);
        await this.fileAction({ cmd: 'lock', space, workId, paths: [path], ...folder });
        return { ok: true };
      },
      'files.requestRelease': async (p) => {
        await this.fileAction({ cmd: 'request-release', ...spacePathParams(p) });
        return { ok: true };
      },
      'files.reveal': async (p) => this.reveal(treeParams(p)),
      'task.focus': async (p) => {
        await this.focusTask(taskIdParam(p));
        return { ok: true };
      },
      'task.lockFiles': async (p) => this.lockFiles(taskIdParam(p)),
      'task.releaseFiles': async (p) => this.releaseFiles(taskIdParam(p), p),
      'task.files': async (p) => this.taskFiles(taskIdParam(p)),
    };
  }

  /**
   * One poll: fetch inbox, notify new tasks, render.
   *
   * Call: only via `poll()`.
   * Expects: nothing.
   * Output: the new view (never throws). A result that arrives after
   * a logout is dropped, so old tasks never come back.
   */
  private async runPoll(): Promise<InboxView> {
    if (!this.view.loggedIn) return this.view;
    const epoch = this.session.epoch();
    try {
      if (!this.companies) await this.loadIdentity();
      const tasks = await this.api().inbox();
      if (!this.isCurrent(epoch)) return this.view; // logged out meanwhile
      const fresh = await this.announce(tasks);
      this.ports.log?.(`poll ok: tasks=${tasks.length} waiting=${waitingTasks(tasks, this.view.osoba).length} new=${fresh}`);
      this.update({ offline: false, tasks, updatedAt: new Date(this.time()).toISOString() });
    } catch (e) {
      await this.pollFailed(e);
    }
    await this.syncFiles(epoch);
    return this.view;
  }

  /**
   * Tells whether a session epoch is still the live, logged-in one.
   *
   * Call: `this.isCurrent(epoch)` after an await.
   * Expects: an epoch read before the await.
   * Output: false after a logout or a new login meanwhile.
   */
  private isCurrent(epoch: number): boolean {
    return this.session.epoch() === epoch && this.view.loggedIn;
  }

  /**
   * Keeps the daemon running for the company and reads its status.
   *
   * Call: `await this.syncFiles(epoch)` at the end of each poll.
   * Expects: the epoch the poll started with.
   * Output: none (never throws); nothing before the company is known
   * (`GET /ja`) or the work folder is chosen; the daemon is
   * (re)started when the company or the work folder changed.
   */
  private async syncFiles(epoch: number): Promise<void> {
    if (!this.companies || !this.config.workFolder || !this.isCurrent(epoch)) return;
    if (this.filesOrg !== this.filesKey()) await this.startFiles(epoch);
    await this.refreshFiles(epoch);
  }

  /**
   * Starts the daemon for the current company.
   *
   * Call: `await this.startFiles(epoch)` from `syncFiles`.
   * Expects: a session (the daemon asks this app for tokens) and the
   * epoch of the calling poll.
   * Output: none; the company is remembered on success and on final
   * refusals (`DISABLED`, `NOT_INSTALLED`), so others retry at the
   * next poll — but only if the session and company are unchanged
   * after the await. A start that ends after a logout is stopped
   * again. Codes go to the log.
   */
  private async startFiles(epoch: number): Promise<void> {
    const org = this.config.company;
    const key = this.filesKey();
    let code: string | null = null;
    try {
      await this.ports.heartwood.start(this.config.heartwoodUrl, this.config.heartwoodWsUrl, org, heartwoodRoot(this.config.workFolder));
    } catch (e) {
      code = errorCode(hwError(e));
      this.ports.log?.(`heartwood start: ${code}`);
    }
    if (!this.view.loggedIn) {
      if (code === null) await this.stopDaemon();
      return;
    }
    if (!this.isCurrent(epoch) || key !== this.filesKey()) return;
    if (code === null || FINAL_START_CODES.includes(code)) this.filesOrg = key;
  }

  /**
   * What the daemon must run for: company and sync root.
   *
   * Call: `this.filesKey()` in `syncFiles` / `startFiles`.
   * Expects: nothing.
   * Output: `<company>` + newline + `<work folder>/Pliki`.
   */
  private filesKey(): string {
    return `${this.config.company}\n${heartwoodRoot(this.config.workFolder)}`;
  }

  /**
   * Stops the daemon and clears the files view.
   *
   * Call: `await this.stopFiles()` on logout, a revoked session or a
   * company change.
   * Expects: nothing.
   * Output: none (never throws); the next poll of a live session
   * starts it again; old status and counts are gone at once.
   */
  private async stopFiles(): Promise<void> {
    this.filesOrg = null;
    await this.stopDaemon();
    this.update({ files: filesView(await this.hwInfo(), null) });
  }

  /**
   * Asks the supervisor to stop the daemon.
   *
   * Call: `await this.stopDaemon()`.
   * Expects: nothing.
   * Output: none (never throws); failures go to the log.
   */
  private async stopDaemon(): Promise<void> {
    await this.ports.heartwood.stop().catch((e: unknown) => this.ports.log?.(`heartwood stop: ${errorCode(hwError(e))}`));
  }

  /**
   * Reads supervisor info and, when running, the daemon status.
   *
   * Call: `await this.refreshFiles(epoch)` from polls, rpc
   * `files.refresh` and after each file action.
   * Expects: the epoch read before the call.
   * Output: the files view (never throws); unchanged when logged
   * out; status `null` when the daemon does not run or fails.
   */
  private async refreshFiles(epoch: number): Promise<FilesView> {
    if (!this.isCurrent(epoch)) return this.view.files;
    const info = await this.hwInfo();
    const status = info.state === 'running' ? await this.readStatus() : null;
    if (this.isCurrent(epoch)) this.update({ files: filesView(info, status) });
    return this.view.files;
  }

  /**
   * Supervisor info.
   *
   * Call: `await this.hwInfo()`.
   * Expects: nothing.
   * Output: the info, or the last known one if the call fails.
   */
  private async hwInfo(): Promise<HwInfo> {
    return this.ports.heartwood.info().catch(() => this.view.files.info);
  }

  /**
   * Asks the daemon for its status.
   *
   * Call: `await this.readStatus()`.
   * Expects: a running daemon.
   * Output: the parsed status, or `null` on any failure (logged).
   */
  private async readStatus(): Promise<HwStatus | null> {
    try {
      return parseStatus(await this.hwCall({ cmd: 'status' }));
    } catch (e) {
      this.ports.log?.(`heartwood status: ${errorCode(e)}`);
      return null;
    }
  }

  /**
   * One local API call with refusals turned into errors.
   *
   * Call: `await this.hwCall(request)`.
   * Expects: a request built from checked params.
   * Output: the `ok: true` reply.
   * Throws: `AppError(code)` for transport failures and refusals.
   */
  private async hwCall(req: HwRequest): Promise<HwReply> {
    let reply: HwReply;
    try {
      reply = await this.ports.heartwood.call(req);
    } catch (e) {
      throw hwError(e);
    }
    checkReply(reply);
    return reply;
  }

  /**
   * A file action followed by a status refresh.
   *
   * Call: `await this.fileAction(request)` from rpc handlers.
   * Expects: a request built from checked params.
   * Output: the reply; the files view refreshes in the background.
   * Throws: like `hwCall`.
   */
  private async fileAction(req: HwRequest): Promise<HwReply> {
    const reply = await this.hwCall(req);
    void this.refreshFiles(this.session.epoch());
    return reply;
  }

  /**
   * Heartwood root of a usable files feature.
   *
   * Call: `await this.filesRoot()` before picking or checking paths.
   * Expects: nothing.
   * Output: the root folder.
   * Throws: `AppError('DISABLED')` / `AppError('NOT_INSTALLED')`
   * when files cannot work on this computer.
   */
  private async filesRoot(): Promise<string> {
    const info = this.view.files.info.root ? this.view.files.info : await this.hwInfo();
    if (info.state === 'disabled') throw new AppError('DISABLED');
    if (info.state === 'not_installed') throw new AppError('NOT_INSTALLED');
    return info.root;
  }

  /**
   * Checks that a path from a window is inside the Heartwood root.
   *
   * Call: `await this.underRoot(path)`.
   * Expects: any string.
   * Output: the same path.
   * Throws: `AppError('OUTSIDE')`, or the errors of `filesRoot`.
   */
  private async underRoot(path: string): Promise<string> {
    if (!isUnderRoot(path, await this.filesRoot())) throw new AppError('OUTSIDE');
    return path;
  }

  /**
   * Reads where a file action points: a local path or a space path.
   *
   * Call: `await this.fileTarget(params, folderOk?)`.
   * Expects: rpc params with `path` and optionally `space`;
   * `folderOk` allows a space folder (`history`).
   * Output: `{ path }` under the root, or `{ space, path }`.
   * Throws: `OUTSIDE` / `BAD_REQUEST` before any daemon call.
   */
  private async fileTarget(params: unknown, folderOk = false): Promise<{ path: string; space?: string }> {
    if (field(params, 'space') !== undefined) return spacePathParams(params, folderOk);
    return { path: await this.underRoot(text(params, 'path')) };
  }

  /**
   * Reads one folder level of a space.
   *
   * Call: rpc `files.tree`.
   * Expects: params checked by `treeParams`.
   * Output: the parsed level.
   * Throws: the daemon's code, or `BAD_RESPONSE` for a reply that
   * does not parse.
   */
  private async tree(params: { space: string; folder?: string }): Promise<HwBrowse> {
    const level = parseBrowse(await this.hwCall({ cmd: 'files', ...params }));
    if (!level) throw new AppError('BAD_RESPONSE');
    return level;
  }

  /**
   * Shows a folder of a selected space in Finder.
   *
   * Call: rpc `files.reveal`.
   * Expects: params checked by `treeParams` (`folder` in the space,
   * `''` or missing = the space root).
   * Output: `{ ok: true }`; the space's local folder comes from a
   * fresh status, never from the window; Finder only shows it
   * (a bundle folder like `X.app` is not launched).
   * Throws: the daemon's code (`TIMEOUT`, `NOT_RUNNING`) when it
   * cannot be asked, `NOT_LOCAL` for a space not on this computer,
   * `OUTSIDE` for a folder outside the Heartwood root,
   * `OPEN_FAILED` when the OS (or the opener scope) refuses.
   */
  private async reveal(params: { space: string; folder?: string }): Promise<{ ok: true }> {
    const status = parseStatus(await this.hwCall({ cmd: 'status' }));
    const base = status?.spaces.find((s) => s.space === params.space)?.folder;
    if (!base) throw new AppError('NOT_LOCAL');
    const sub = (params.folder ?? '').replace(/\/$/, '');
    const path = sub ? `${base}/${sub}` : base;
    if (!isUnderRoot(path, await this.filesRoot())) throw new AppError('OUTSIDE');
    await this.ports.revealFolder(path).catch(() => {
      throw new AppError('OPEN_FAILED');
    });
    return { ok: true };
  }

  /**
   * Files of a task's work with the user's `sub`.
   *
   * Call: rpc `task.files`.
   * Expects: a checked task id.
   * Output: `{ id, files, me }`; `id` lets the window drop a reply
   * for a task it no longer shows.
   * Throws: like `workFiles`.
   */
  private async taskFiles(taskId: string): Promise<Methods['task.files']['result']> {
    const files = await this.workFiles(taskId);
    return { id: taskId, files, me: await this.mySub() };
  }

  /**
   * Reads all pages of a task's work files.
   *
   * Call: `await this.workFiles(taskId)`.
   * Expects: a checked task id.
   * Output: the first page with the versions of up to
   * `MAX_WORK_PAGES` pages appended; `cursor` is kept only when
   * pages were left unread.
   * Throws: like `workFilesPage`.
   */
  private async workFiles(taskId: string): Promise<HwWorkFiles> {
    const workId = workIdFor(taskId);
    const first = await this.workFilesPage(workId);
    const versions = [...first.versions];
    let cursor = first.cursor;
    for (let page = 1; cursor && page < MAX_WORK_PAGES; page++) {
      const next = await this.workFilesPage(workId, cursor);
      versions.push(...next.versions);
      cursor = next.cursor;
    }
    const { writer, closed, locks, hiddenLocks } = first;
    return { writer, closed, locks, hiddenLocks, versions, ...(cursor ? { cursor } : {}) };
  }

  /**
   * Reads one page of a work's files.
   *
   * Call: `await this.workFilesPage(workId, cursor?)`.
   * Expects: a work id; the cursor of the previous page, if any.
   * Output: the parsed page.
   * Throws: the daemon's code, or `BAD_RESPONSE` for a reply that
   * does not parse.
   */
  private async workFilesPage(workId: string, cursor?: string): Promise<HwWorkFiles> {
    const page = parseWorkFiles(await this.hwCall({ cmd: 'work-files', workId, ...(cursor ? { cursor } : {}) }));
    if (!page) throw new AppError('BAD_RESPONSE');
    return page;
  }

  /**
   * The user's `sub` (compared with a work's `writer`).
   *
   * Call: `await this.mySub()`.
   * Expects: nothing.
   * Output: `sub` of the stored access token, `null` without a
   * session, when the keychain refuses or for an odd token.
   */
  private async mySub(): Promise<string | null> {
    const s = await this.session.current().catch(() => null);
    return s ? subOf(s.accessToken) : null;
  }

  /**
   * Lets the user pick files under the root.
   *
   * Call: `await this.pickUnderRoot()`.
   * Expects: nothing.
   * Output: the root and the picked paths (`[]` when cancelled).
   * Throws: `AppError('OUTSIDE')` when any path is outside the root.
   */
  private async pickUnderRoot(): Promise<{ root: string; paths: string[] }> {
    const root = await this.filesRoot();
    const paths = await this.ports.heartwood.pickFiles(root);
    if (!paths.every((p) => isUnderRoot(p, root))) throw new AppError('OUTSIDE');
    return { root, paths };
  }

  /**
   * Picks one file for its history.
   *
   * Call: rpc `files.pickPath`.
   * Expects: nothing.
   * Output: `{ path }` of the first picked file, `null` if cancelled.
   */
  private async pickPath(): Promise<{ path: string | null }> {
    return { path: (await this.pickUnderRoot()).paths[0] ?? null };
  }

  /**
   * Locks files the user picks for a task (D11).
   *
   * Call: rpc `task.lockFiles`.
   * Expects: a checked task id.
   * Output: `{ paths }` = the picked paths; one `lock` per space.
   * Throws: `OUTSIDE` before any call, or the daemon's code (spaces
   * locked before it stay locked).
   */
  private async lockFiles(taskId: string): Promise<{ paths: string[] }> {
    const { root, paths } = await this.pickUnderRoot();
    for (const group of groupBySpace(paths, root)) {
      for (const batch of inBatches(group)) {
        await this.fileAction({ cmd: 'lock', workId: workIdFor(taskId), paths: batch });
      }
    }
    return { paths };
  }

  /**
   * Releases one lock or every visible lock of a task.
   *
   * Call: rpc `task.releaseFiles`.
   * Expects: a checked task id; params with `space` + `path` name
   * one lock, without them the locks of `work-files` are released.
   * Output: `{ paths }` released (space paths); one `release` per
   * space.
   * Throws: `BAD_REQUEST` for a bad space path, or the daemon's
   * code (spaces released before it stay released).
   */
  private async releaseFiles(taskId: string, params: unknown): Promise<{ paths: string[] }> {
    if (field(params, 'space') !== undefined || field(params, 'path') !== undefined) {
      const { space, path } = spacePathParams(params);
      await this.fileAction({ cmd: 'release', space, paths: [path] });
      return { paths: [path] };
    }
    const groups = locksBySpace((await this.workFilesPage(workIdFor(taskId))).locks);
    for (const { space, paths } of groups) {
      for (const batch of inBatches(paths)) await this.fileAction({ cmd: 'release', space, paths: batch });
    }
    return { paths: groups.flatMap((g) => g.paths) };
  }

  /**
   * Handles a failed poll.
   *
   * Call: from `runPoll`'s catch.
   * Expects: the thrown value.
   * Output: none. Login required → logged-out view, notification
   * memory cleared, login screen;
   * anything else (network, server error) → `offline`, tasks kept.
   */
  private async pollFailed(e: unknown): Promise<void> {
    this.ports.log?.(`poll failed: ${errorCode(e)}`);
    if (e instanceof LoginRequiredError) {
      clearSeen(this.ports.store);
      this.update({ loggedIn: false, offline: false, tasks: [] });
      await this.stopFiles();
      await this.ports.showScreen('login');
      return;
    }
    this.update({ offline: true });
  }

  /**
   * Sends notifications for tasks not seen before.
   *
   * Call: `await this.announce(tasks)` after each successful fetch.
   * Expects: the full inbox.
   * Output: number of new tasks; a failed notification is logged and
   * skipped (the tray count still shows the task); seen set saved.
   */
  private async announce(tasks: Task[]): Promise<number> {
    const { fresh, seen } = pickNew(tasks, loadSeen(this.ports.store), this.view.osoba);
    saveSeen(this.ports.store, seen);
    for (const t of fresh) {
      await this.ports.notify(notificationTitle(t), notificationBody(t.opis))
        .catch((e: unknown) => this.ports.log?.(`notify failed: ${String(e)}`));
    }
    return fresh.length;
  }

  /**
   * Loads who the user is and settles the company.
   *
   * Call: `await this.loadIdentity()` before the first inbox fetch of
   * a session (the inbox needs the company header).
   * Expects: a session.
   * Output: none; `companies` and `view.osoba` are set. A stored
   * company the person does not belong to is replaced by their first
   * company, so a single-company user never has to choose.
   * Throws: errors of `ApiClient.me` (handled like a failed poll).
   */
  private async loadIdentity(): Promise<void> {
    const list = await this.api().me();
    this.companies = list;
    const keep = list.some((m) => m.firma === this.config.company);
    const first = list[0];
    if (!keep && first) this.applyChoices({ company: first.firma });
    this.update({ osoba: list.find((m) => m.firma === this.config.company)?.osoba ?? null });
  }

  /**
   * Switches to another company of the user.
   *
   * Call: rpc `config.setCompany`.
   * Expects: one of the companies from `GET /ja`.
   * Output: `{ ok: true }`; tasks and notification memory reset, the
   * old company's daemon stopped (its status cleared) and a poll for
   * the new company starts (it starts the daemon again).
   * Throws: `AppError('BAD_COMPANY')` for any other value.
   */
  private async setCompany(company: string): Promise<{ ok: true }> {
    const member = this.companies?.find((m) => m.firma === company);
    if (!member) throw new AppError('BAD_COMPANY');
    this.applyChoices({ company });
    clearSeen(this.ports.store);
    this.update({ osoba: member.osoba, tasks: [] });
    await this.stopFiles();
    void this.poll();
    return { ok: true };
  }

  /**
   * Login step 1: e-mail the code.
   *
   * Call: rpc `login.sendCode`.
   * Expects: an e-mail address.
   * Output: the normalised address; the pending login stays in memory
   * of this window only.
   */
  private async sendCode(email: string): Promise<{ email: string }> {
    this.pending = await startEmailLogin(this.cognito(), email);
    return { email: this.pending.email };
  }

  /**
   * Login step 2: check the code, store tokens, poll.
   *
   * Call: rpc `login.confirm`.
   * Expects: a pending login.
   * Output: the logged-in e-mail.
   * Throws: `CognitoError('NO_PENDING_LOGIN')`; `WRONG_CODE` keeps the
   * pending login for a retry, other errors drop it.
   */
  private async confirm(code: string): Promise<{ email: string }> {
    const pending = this.pending;
    if (!pending) throw new CognitoError('NO_PENDING_LOGIN');
    try {
      await this.session.start(pending.email, await confirmEmailCode(this.cognito(), pending, code));
    } catch (e) {
      if (!(e instanceof CognitoError && e.code === 'WRONG_CODE')) this.pending = null;
      throw e;
    }
    this.pending = null;
    this.update({ loggedIn: true, offline: false, email: pending.email });
    void this.poll();
    return { email: pending.email };
  }

  /**
   * Takes a task and refreshes the inbox.
   *
   * Call: rpc `inbox.take`.
   * Expects: a task id.
   * Output: `TAKEN` or `BUSY` with the owner's name.
   */
  private async take(id: string): Promise<Methods['inbox.take']['result']> {
    const r = await this.api().take(id);
    void this.poll();
    return r.status === 'TAKEN' ? { status: 'TAKEN' } : r;
  }

  /**
   * Runs one change of a task and refreshes the inbox.
   *
   * Call: `this.change(() => api.reject(...))` from rpc handlers.
   * Expects: an API call that validates its own input.
   * Output: `{ ok: true }`; errors of the call propagate to the UI.
   */
  private async change(op: () => Promise<unknown>): Promise<{ ok: true }> {
    await op();
    void this.poll();
    return { ok: true };
  }

  /**
   * Asks colleagues to review a PR and refreshes the inbox.
   *
   * Call: rpc `review.request` with `{ repo, pr, reviewers }`.
   * Expects: values from the form (validated by `ApiClient`).
   * Output: `{ taskId }` of the created review-request task.
   */
  private async requestReview(p: unknown): Promise<{ taskId: string }> {
    const reviewers = field(p, 'reviewers');
    const list = Array.isArray(reviewers) ? reviewers.filter((r): r is string => typeof r === 'string') : [];
    const pr = field(p, 'pr');
    const task = await this.api().requestReview(text(p, 'repo'), typeof pr === 'number' ? pr : NaN, list);
    void this.poll();
    return { taskId: task.id };
  }

  /**
   * Stores the work folder chosen in the guided setup.
   *
   * Call: rpc `config.setWorkFolder`.
   * Expects: a path from the folder picker.
   * Output: `{ ok: true }`; the view's `workFolder` is updated.
   * Throws: `AppError('BAD_FOLDER')` for an unsafe or empty path.
   */
  private async setWorkFolder(path: string): Promise<{ ok: true }> {
    if (!isSafeFolder(path)) throw new AppError('BAD_FOLDER');
    this.applyChoices({ workFolder: path });
    return { ok: true };
  }

  /**
   * Stores changed user choices and reflects them in the view.
   *
   * Call: `this.applyChoices({ workFolder })` or `({ company })`.
   * Expects: values already checked by the caller.
   * Output: none; stored, kept in memory, folder rendered.
   * Throws: `AppError('BAD_CHOICE')` if validation still fails.
   */
  private applyChoices(change: Partial<UserChoices>): void {
    const check = saveChoices(this.ports.store, { company: this.config.company, workFolder: this.config.workFolder, ...change });
    if (!check.ok) throw new AppError('BAD_CHOICE');
    this.config = check.config;
    this.update({ workFolder: check.config.workFolder });
  }

  /**
   * Lets the user pick the work folder in the OS dialog.
   *
   * Call: rpc `config.pickFolder` from the settings screen.
   * Expects: the folder currently in the form (dialog starts there
   * when it is a safe path).
   * Output: `{ path }` (not saved yet — the form saves it), or
   * `{ path: null }` when cancelled.
   * Throws: `AppError('BAD_FOLDER')` for a path the config would
   * refuse (e.g. a network volume with `..`).
   */
  private async pickFolder(current: string): Promise<{ path: string | null }> {
    const path = await this.ports.pickFolder(isSafeFolder(current) ? current : '');
    if (path === null) return { path: null };
    if (!isSafeFolder(path)) throw new AppError('BAD_FOLDER');
    return { path };
  }

  /**
   * Opens Claude Code for a task: the remembered thread, or a new one.
   *
   * Call: rpc `task.openInClaude` (`newThread: true` forces a new one).
   * Expects: a task id; a new-session link holds only the id and the
   * work folder; a thread comes from the last fetched inbox and must
   * be a Claude Desktop session id.
   * Output: `{ ok: true }` once the OS accepted the link.
   * Throws: `AppError('NO_WORK_FOLDER')` before setup is finished,
   * `AppError('BAD_TASK_ID')`, `AppError('CLAUDE_NOT_FOUND')` when no
   * app handles `claude://` (the cause is logged).
   */
  private async openInClaude(id: string, newThread: boolean): Promise<{ ok: true }> {
    if (!this.config.workFolder) {
      await this.ports.showScreen('login');
      throw new AppError('NO_WORK_FOLDER');
    }
    const thread = newThread ? undefined : this.view.tasks.find((t) => t.id === id)?.watek;
    const link = thread && THREAD_PATTERN.test(thread) ? threadLink(thread) : claudeLink(id, this.config.workFolder);
    try {
      await this.ports.openUrl(link);
    } catch (e) {
      this.ports.log?.(`open claude failed: ${String(e)}`);
      throw new AppError('CLAUDE_NOT_FOUND');
    }
    return { ok: true };
  }

  /**
   * Merges a change into the view and renders it.
   *
   * Call: `this.update({ ... })`.
   * Expects: a partial view.
   * Output: none; `ports.render` gets the full view.
   */
  private update(change: Partial<InboxView>): void {
    this.view = { ...this.view, ...change };
    this.ports.render(this.view);
  }

  /**
   * Cognito context for the current config.
   *
   * Call: `this.cognito()`.
   * Expects: nothing.
   * Output: region, client id, fetch and clock.
   */
  private cognito(): CognitoContext {
    return { fetch: this.ports.fetch, region: this.config.region, clientId: this.config.clientId, now: this.ports.now };
  }

  /**
   * API client for the current config.
   *
   * Call: `this.api()`.
   * Expects: nothing.
   * Output: a client bound to the current config and session.
   */
  private api(): ApiClient {
    return new ApiClient(this.config, this.session, this.ports.fetch);
  }

  /**
   * Current time.
   *
   * Call: `this.time()`.
   * Expects: nothing.
   * Output: epoch ms from the injected clock or `Date.now`.
   */
  private time(): number {
    return (this.ports.now ?? Date.now)();
  }
}

/**
 * Count of tasks waiting for the user.
 *
 * Call: `waitingCount(view)`.
 * Expects: a view.
 * Output: number of `nowe`/`eskalowane` tasks.
 */
export function waitingCount(view: InboxView): number {
  return waitingTasks(view.tasks, view.osoba).length;
}

/**
 * Reads a field of rpc params.
 *
 * Call: `field(params, 'config')`.
 * Expects: anything as params.
 * Output: the field value or `undefined`.
 */
function field(params: unknown, name: string): unknown {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[name] : undefined;
}

/**
 * Reads an optional string field of rpc params.
 *
 * Call: `optionalText(params, 'acceptor')`.
 * Expects: anything as params.
 * Output: the string, or undefined when missing or not a string.
 */
function optionalText(params: unknown, name: string): string | undefined {
  const v = field(params, name);
  return typeof v === 'string' ? v : undefined;
}

/**
 * Reads a string field of rpc params.
 *
 * Call: `text(params, 'email')`.
 * Expects: anything as params.
 * Output: the string, or `''` when missing or not a string (the
 * callee then rejects it).
 */
function text(params: unknown, name: string): string {
  const v = field(params, name);
  return typeof v === 'string' ? v : '';
}

/** Methods served by `fileHandlers`. */
type FileMethod = Extract<keyof Methods, `files.${string}` | 'task.lockFiles' | 'task.releaseFiles' | 'task.files' | 'task.focus'>;

/**
 * Reads a task id param.
 *
 * Call: `taskIdParam(params)`; `taskIdParam(params, 'taskId')`.
 * Expects: anything as params; the field name defaults to `id`.
 * Output: the id.
 * Throws: `AppError('BAD_TASK_ID')` unless it matches the pattern.
 */
function taskIdParam(params: unknown, name = 'id'): string {
  const id = text(params, name);
  if (!TASK_ID_PATTERN.test(id)) throw new AppError('BAD_TASK_ID');
  return id;
}

/**
 * Reads a version number param.
 *
 * Call: `versionParam(params)`.
 * Expects: anything as params.
 * Output: the version (`seq`), an integer ≥ 0.
 * Throws: `AppError('BAD_REQUEST')` otherwise.
 */
function versionParam(params: unknown): number {
  const v = field(params, 'version');
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new AppError('BAD_REQUEST');
  return v as number;
}

/**
 * Reads the space and optional topics of select/unselect.
 *
 * Call: `scopeParams(params)`.
 * Expects: anything as params.
 * Output: `{ space }` plus `topics` when given.
 * Throws: `AppError('BAD_REQUEST')` for an empty or long space, or
 * topics that are not a list of such names.
 */
function scopeParams(params: unknown): { space: string; topics?: string[] } {
  const space = text(params, 'space');
  const topics = field(params, 'topics');
  if (!isName(space)) throw new AppError('BAD_REQUEST');
  if (topics === undefined) return { space };
  if (!Array.isArray(topics) || !topics.every(isName)) throw new AppError('BAD_REQUEST');
  return { space, topics };
}

/**
 * Reads a space and a path inside it.
 *
 * Call: `spacePathParams(params)`; `(params, true)` for `history`.
 * Expects: anything as params; `folderOk` allows a folder path
 * (`''` or a trailing `/`).
 * Output: `{ space, path }`.
 * Throws: `AppError('BAD_REQUEST')` for a bad name or path (an
 * absolute local path, `..`, empty segments, control characters).
 */
function spacePathParams(params: unknown, folderOk = false): { space: string; path: string } {
  const space = text(params, 'space');
  const path = field(params, 'path');
  if (!isName(space) || typeof path !== 'string' || !isSpacePath(path, folderOk)) throw new AppError('BAD_REQUEST');
  return { space, path };
}

/**
 * Reads the params of `files.tree`.
 *
 * Call: `treeParams(params)`.
 * Expects: anything as params.
 * Output: `{ space }` plus `folder` when given (`''` = root).
 * Throws: `AppError('BAD_REQUEST')` for a bad space or folder.
 */
function treeParams(params: unknown): { space: string; folder?: string } {
  const space = text(params, 'space');
  const folder = field(params, 'folder');
  if (!isName(space)) throw new AppError('BAD_REQUEST');
  if (folder === undefined) return { space };
  if (typeof folder !== 'string' || !isSpacePath(folder, true)) throw new AppError('BAD_REQUEST');
  return { space, folder };
}

/**
 * Checks a space or topic name before it reaches the daemon.
 *
 * Call: `isName(v)`.
 * Expects: anything.
 * Output: true for a non-empty string of at most `MAX_NAME` chars.
 */
function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME;
}
