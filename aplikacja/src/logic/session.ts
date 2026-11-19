// Session lifecycle: keychain persistence, silent refresh and the
// rule that only a revoked refresh token logs the user out.
import type { Tokens } from './cognito.js';
import { CognitoError, LoginRequiredError } from './errors.js';

/** Secure storage for one string (the OS keychain in the app). */
export interface Vault {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Stored session: tokens, the e-mail shown in the UI and the Cognito
 * app client that issued them (a session of another client is void).
 */
export interface Session extends Tokens { email: string; clientId: string }

/**
 * Refresh when the access token expires within this window. Five
 * minutes, so that the background poll (every 60 s) keeps the stored
 * token valid for the Heartwood `token_command` (needs >= 60 s).
 */
export const REFRESH_MARGIN_MS = 300_000;

/** Cognito refresh errors that mean "log in again". */
export const LOGOUT_ERRORS: readonly string[] = ['NotAuthorizedException', 'UserNotFoundException'];

/** Exchanges a refresh token for new tokens (Cognito in the app). */
export type Refresher = (refreshToken: string) => Promise<Tokens>;

/** Owns the session; the only code that touches tokens. */
export class SessionManager {
  private cached: Session | null | undefined;
  private refreshing: Promise<Session> | null = null;
  private generation = 0;

  /**
   * Call: `new SessionManager(vault, refresher, clientId, now?)`.
   * Expects: a vault, a refresher and the app client id the session
   * must belong to; `now` defaults to `Date.now`.
   * Output: a manager that loads lazily from the vault.
   */
  constructor(
    private readonly vault: Vault,
    private readonly refresher: Refresher,
    private readonly clientId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns the current session.
   *
   * Call: `await manager.current()`.
   * Expects: nothing; a corrupt vault value counts as no session.
   * Output: the session or `null` (first read hits the vault). A
   * session without a `clientId`, or of another client, counts as no
   * session and is removed from the vault, so no old token lingers.
   */
  async current(): Promise<Session | null> {
    if (this.cached === undefined) {
      const loaded = parseSession(await this.vault.read());
      if (loaded && loaded.clientId !== this.clientId) {
        await this.vault.remove();
        this.cached = null;
      } else {
        this.cached = loaded;
      }
    }
    return this.cached;
  }

  /**
   * Stores a new session after login.
   *
   * Call: `await manager.start(email, tokens)`.
   * Expects: tokens from `confirmEmailCode`.
   * Output: none; the session is in the vault and in memory.
   */
  async start(email: string, tokens: Tokens): Promise<void> {
    this.generation += 1;
    await this.store({ ...tokens, email, clientId: this.clientId });
  }

  /**
   * Identifies the current login.
   *
   * Call: `manager.epoch()` before an await; compare after it.
   * Expects: nothing.
   * Output: a number that changes on every login and logout, so work
   * started for an earlier session can be dropped.
   */
  epoch(): number {
    return this.generation;
  }

  /**
   * Returns a usable access token, refreshing it when needed.
   *
   * Call: `await manager.accessToken()` before each API call.
   * Expects: nothing.
   * Output: an access token valid for more than `REFRESH_MARGIN_MS`
   * (or as fresh as Cognito gives).
   * Throws: `LoginRequiredError` without a session or when the refresh
   * token is revoked; `NetworkError` when offline (session kept).
   */
  async accessToken(): Promise<string> {
    const session = await this.requireSession();
    if (session.expiresAt - this.now() > REFRESH_MARGIN_MS) return session.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Forces a refresh (after the API answered 401).
   *
   * Call: `await manager.forceRefresh()`.
   * Expects: nothing.
   * Output and errors: as `accessToken()`.
   */
  async forceRefresh(): Promise<string> {
    await this.requireSession();
    return (await this.refresh()).accessToken;
  }

  /**
   * Logs out locally.
   *
   * Call: `await manager.logout()`.
   * Expects: nothing; works without a session.
   * Output: none; vault entry and memory are cleared.
   */
  async logout(): Promise<void> {
    this.generation += 1;
    this.cached = null;
    await this.vault.remove();
  }

  /**
   * Returns the session or fails.
   *
   * Call: `await this.requireSession()`.
   * Expects: nothing.
   * Output: the session.
   * Throws: `LoginRequiredError` when there is none.
   */
  private async requireSession(): Promise<Session> {
    const session = await this.current();
    if (!session) throw new LoginRequiredError();
    return session;
  }

  /**
   * Refreshes once; concurrent callers share the same request.
   *
   * Call: `await this.refresh()`.
   * Expects: an existing session.
   * Output: the refreshed, stored session.
   * Throws: see `runRefresh`.
   */
  private refresh(): Promise<Session> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Performs the refresh and applies the logout rule.
   *
   * Call: only via `refresh()`.
   * Expects: an existing session.
   * Output: the new session, stored in the vault.
   * Throws: `LoginRequiredError` (and clears the vault) only for
   * `LOGOUT_ERRORS`; any other error (network, throttling) is
   * rethrown and the session is kept. A result that arrives after a
   * logout/login in the meantime is dropped (`LoginRequiredError`),
   * so a logout always sticks.
   */
  private async runRefresh(): Promise<Session> {
    const session = await this.requireSession();
    const started = this.generation;
    let tokens: Tokens;
    try {
      tokens = await this.refresher(session.refreshToken);
    } catch (e) {
      if (e instanceof CognitoError && LOGOUT_ERRORS.includes(e.code)) {
        await this.logout();
        throw new LoginRequiredError();
      }
      throw e;
    }
    if (this.generation !== started) throw new LoginRequiredError();
    const next = { ...tokens, email: session.email, clientId: this.clientId };
    await this.store(next);
    return next;
  }

  /**
   * Writes a session to the vault and memory.
   *
   * Call: `await this.store(session)`.
   * Expects: a complete session.
   * Output: none.
   */
  private async store(session: Session): Promise<void> {
    await this.vault.write(JSON.stringify(session));
    this.cached = session;
  }
}

/**
 * Parses a vault value into a session.
 *
 * Call: `parseSession(raw)`.
 * Expects: the raw vault string or `null`.
 * Output: the session when all fields are present and typed,
 * otherwise `null`. A missing `clientId` parses as `''`, which never
 * matches a real client (the manager then drops the session).
 */
export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Session>;
    const ok = typeof o.accessToken === 'string' && typeof o.refreshToken === 'string'
      && typeof o.expiresAt === 'number' && typeof o.email === 'string';
    return ok ? ({ ...o, clientId: typeof o.clientId === 'string' ? o.clientId : '' } as Session) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the `sub` claim of an access token.
 *
 * Call: `subOf(session.accessToken)`.
 * Expects: any string; the signature is NOT checked, so the result
 * only serves to compare with a `writer` the daemon reports.
 * Output: a non-empty `sub`, or `null` for anything that is not a
 * three-part JWT with a JSON object payload holding a string `sub`.
 */
export function subOf(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const sub = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).sub : undefined;
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}
