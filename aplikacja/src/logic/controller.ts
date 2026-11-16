// Brain of the background window: owns config, session, polling,
// notifications and the rpc handlers. Platform effects are injected
// as ports, so the whole flow is unit-tested without Tauri.
import type { Task, UserSettableState } from '@cognifly/wspolne/api';
import type { InboxView, Methods, Screen } from '../windows/protocol.js';
import { ApiClient } from './api.js';
import { confirmEmailCode, refreshTokens, startEmailLogin, type CognitoContext, type PendingLogin } from './cognito.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AppConfig } from './config.js';
import { CognitoError, errorCode, LoginRequiredError } from './errors.js';
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
  /** Brings the main window to the front on the given screen. */
  showScreen(screen: Screen): Promise<void>;
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
  private view: InboxView = { loggedIn: false, offline: false, email: null, tasks: [], updatedAt: null };

  /**
   * Call: `new Controller(ports)`.
   * Expects: ports of the running platform.
   * Output: a controller with config loaded; call `start()` next.
   */
  constructor(private readonly ports: Ports) {
    this.config = loadConfig(ports.store);
    this.session = new SessionManager(ports.vault, (rt) => refreshTokens(this.cognito(), rt), ports.now);
  }

  /**
   * Starts the app: restores the session and polls once.
   *
   * Call: `await controller.start()` when the background window loads.
   * Expects: nothing.
   * Output: the first view; without a session (or when the keychain
   * refuses access) the main window opens on the guided login.
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
    this.update({ loggedIn: false, offline: false, email: null, tasks: [], updatedAt: null });
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
      'config.get': async () => ({ config: this.config, defaults: { ...DEFAULT_CONFIG } }),
      'config.save': (p) => this.saveSettings(field(p, 'config')),
      'login.sendCode': (p) => this.sendCode(text(p, 'email')),
      'login.confirm': (p) => this.confirm(text(p, 'code')),
      'inbox.get': async () => this.view,
      'inbox.refresh': () => this.poll(),
      'inbox.take': (p) => this.take(text(p, 'id')),
      'inbox.setState': (p) => this.setState(text(p, 'id'), text(p, 'state')),
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
   * Validates and applies new settings.
   *
   * Call: rpc `config.save`.
   * Expects: raw settings from the form.
   * Output: `{ ok: true }` or the invalid field. Changing the user
   * pool (region/client id) logs out; changing API or company resets
   * the notification memory so nothing old is announced as new.
   */
  private async saveSettings(input: unknown): Promise<Methods['config.save']['result']> {
    const before = this.config;
    const check = saveConfig(this.ports.store, input);
    if (!check.ok) return check;
    this.config = check.config;
    if (before.region !== check.config.region || before.clientId !== check.config.clientId) await this.logout();
    else if (before.apiUrl !== check.config.apiUrl || before.company !== check.config.company) clearSeen(this.ports.store);
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
