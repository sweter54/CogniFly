// Brain of the background window: owns config, session, polling,
// notifications and the rpc handlers. Platform effects are injected
// as ports, so the whole flow is unit-tested without Tauri.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { InboxView, Methods, Screen } from '../windows/protocol.js';
import { ApiClient, type Membership } from './api.js';
import { confirmEmailCode, refreshTokens, startEmailLogin, type CognitoContext, type PendingLogin } from './cognito.js';
import { isSafeFolder, loadConfig, saveChoices, type AppConfig, type UserChoices } from './config.js';
import { claudeLink } from './claude-link.js';
import { AppError, CognitoError, errorCode, LoginRequiredError } from './errors.js';
import type { FetchFn } from './http.js';
import { clearSeen, loadSeen, notificationBody, notificationTitle, pickNew, saveSeen, waitingTasks } from './notify.js';
import type { Handler } from './rpc.js';
import { SessionManager, type Vault } from './session.js';
import type { KeyValueStore } from './storage.js';

/** Poll interval (ms). */
export const POLL_INTERVAL_MS = 60_000;

/** Platform effects used by the controller. */
export interface Ports {
  store: KeyValueStore;
  vault: Vault;
  fetch: FetchFn;
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

  /**
   * Call: `new Controller(ports)`.
   * Expects: ports of the running platform.
   * Output: a controller with config loaded; call `start()` next.
   */
  constructor(private readonly ports: Ports) {
    this.config = loadConfig(ports.store);
    this.view = { loggedIn: false, offline: false, email: null, osoba: null, tasks: [], updatedAt: null, workFolder: this.config.workFolder };
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
   * Output: none; view becomes logged out.
   */
  async logout(): Promise<void> {
    await this.session.logout();
    clearSeen(this.ports.store);
    this.pending = null;
    this.companies = null;
    this.update({ loggedIn: false, offline: false, email: null, osoba: null, tasks: [], updatedAt: null });
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
      'inbox.setState': (p) => this.setState(text(p, 'id'), text(p, 'state')),
      'task.openInClaude': (p) => this.openInClaude(text(p, 'id')),
      'config.pickFolder': (p) => this.pickFolder(text(p, 'current')),
      'config.setWorkFolder': (p) => this.setWorkFolder(text(p, 'path')),
      'session.logout': async () => {
        await this.logout();
        return { ok: true };
      },
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
      if (this.session.epoch() !== epoch || !this.view.loggedIn) return this.view; // logged out meanwhile
      const fresh = await this.announce(tasks);
      this.ports.log?.(`poll ok: tasks=${tasks.length} waiting=${waitingTasks(tasks).length} new=${fresh}`);
      this.update({ offline: false, tasks, updatedAt: new Date(this.time()).toISOString() });
    } catch (e) {
      await this.pollFailed(e);
    }
    return this.view;
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
    const { fresh, seen } = pickNew(tasks, loadSeen(this.ports.store));
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
   * Output: `{ ok: true }`; tasks and notification memory reset and
   * a poll for the new company starts.
   * Throws: `AppError('BAD_COMPANY')` for any other value.
   */
  private async setCompany(company: string): Promise<{ ok: true }> {
    const member = this.companies?.find((m) => m.firma === company);
    if (!member) throw new AppError('BAD_COMPANY');
    this.applyChoices({ company });
    clearSeen(this.ports.store);
    this.update({ osoba: member.osoba, tasks: [] });
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
   * Changes a task's state and refreshes the inbox.
   *
   * Call: rpc `inbox.setState`.
   * Expects: id and state; `ApiClient.setState` rejects states
   * outside `USER_SETTABLE_STATES` before any request.
   * Output: `{ ok: true }`.
   */
  private async setState(id: string, state: string): Promise<{ ok: true }> {
    await this.api().setState(id, state as UserSettableState);
    void this.poll();
    return { ok: true };
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
   * Opens a Claude Code session for a task.
   *
   * Call: rpc `task.openInClaude`.
   * Expects: a task id; the link holds only the id and the work folder.
   * Output: `{ ok: true }` once the OS accepted the link.
   * Throws: `AppError('NO_WORK_FOLDER')` before setup is finished,
   * `AppError('BAD_TASK_ID')`, `AppError('CLAUDE_NOT_FOUND')` when no
   * app handles `claude://` (the cause is logged).
   */
  private async openInClaude(id: string): Promise<{ ok: true }> {
    if (!this.config.workFolder) {
      await this.ports.showScreen('login');
      throw new AppError('NO_WORK_FOLDER');
    }
    const link = claudeLink(id, this.config.workFolder);
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
  return waitingTasks(view.tasks).length;
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
