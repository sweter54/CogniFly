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
   * Call: `new CognitoError(type)` with the short Cognito error type.
   * Expects: `type` without the `namespace#` prefix.
   * Output: error whose `code` is `type`.
   */
  constructor(readonly code: string) {
    super(code);
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

/**
 * Maps any thrown value to a stable error code for the UI.
 *
 * Call: `errorCode(e)` in catch blocks before replying to a window.
 * Expects: anything.
 * Output: the error's code for known errors, otherwise `UNEXPECTED`.
 * Never returns the raw message of unknown errors (may hold data).
 */
export function errorCode(e: unknown): string {
  if (e instanceof NetworkError || e instanceof LoginRequiredError) return e.message;
  if (e instanceof CognitoError || e instanceof ApiError) return e.code;
  return 'UNEXPECTED';
}
