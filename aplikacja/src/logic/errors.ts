// Error types shared by all logic modules. Codes are stable strings
// that the UI maps to Polish messages; they never carry token values.

/** Network failure or timeout: the session must be kept. */
export class NetworkError extends Error {
  /**
   * Call: `new NetworkError()` when a request did not get a response.
   * Expects: nothing.
   * Output: error with code `NETWORK`.
   */
  constructor() {
    super('NETWORK');
    this.name = 'NetworkError';
  }
}

/** The user has to log in again (no session or session revoked). */
export class LoginRequiredError extends Error {
  /**
   * Call: `new LoginRequiredError()`.
   * Expects: nothing.
   * Output: error with code `LOGIN_REQUIRED`.
   */
  constructor() {
    super('LOGIN_REQUIRED');
    this.name = 'LoginRequiredError';
  }
}

/** Cognito answered with an error type (e.g. `CodeMismatchException`). */
export class CognitoError extends Error {
  /**
   * Call: `new CognitoError(code, detail?)`.
   * Expects: `code` = short Cognito error type (no `namespace#`) or an
   * app code; `detail` = the original Cognito type behind an app code.
   * Output: error whose `code` goes to the UI; the message adds the
   * detail for the log (never a user code or token).
   */
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code} (${detail})` : code);
    this.name = 'CognitoError';
  }
}

/** CogniFly API answered with a non-success status. */
export class ApiError extends Error {
  /**
   * Call: `new ApiError(status, code)`.
   * Expects: `code` from the response body `kod` or `HTTP_<status>`.
   * Output: error carrying both values.
   */
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'ApiError';
  }
}

/** App-level failure with a stable code (e.g. `CLAUDE_NOT_FOUND`). */
export class AppError extends Error {
  /**
   * Call: `new AppError(code)`.
   * Expects: a stable, user-data-free code.
   * Output: error whose `code` goes to the UI.
   */
  constructor(readonly code: string) {
    super(code);
    this.name = 'AppError';
  }
}

/**
 * Maps any thrown value to a stable error code for the UI.
 *
 * Call: `errorCode(e)` in catch blocks before replying to a window.
 * Expects: anything.
 * Output: the error's code for known errors and for keychain codes
 * (`VAULT_*` strings rejected by the Rust commands), otherwise
 * `UNEXPECTED`. Never returns raw messages of unknown errors.
 */
export function errorCode(e: unknown): string {
  if (typeof e === 'string' && /^VAULT_[A-Z_]+$/.test(e)) return e;
  if (e instanceof NetworkError || e instanceof LoginRequiredError) return e.message;
  if (e instanceof CognitoError || e instanceof ApiError || e instanceof AppError) return e.code;
  return 'UNEXPECTED';
}
