// Cognito user-pool calls for passwordless login (USER_AUTH +
// EMAIL_OTP) and token refresh. Request shapes match the live-tested
// CLI (`wtyczka/cli/lib/sesja.mjs`).
import { CognitoError } from './errors.js';
import { requestJson, stringField, type FetchFn } from './http.js';

/** What every Cognito call needs. */
export interface CognitoContext {
  fetch: FetchFn;
  region: string;
  clientId: string;
  now?: () => number;
}

/** Tokens kept in the keychain. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

/** Pending login between "send code" and "confirm code". */
export interface PendingLogin { email: string; session: string }

/**
 * Builds the Cognito endpoint URL for a region.
 *
 * Call: `cognitoEndpoint('eu-central-1')`.
 * Expects: a validated region string.
 * Output: `https://cognito-idp.<region>.amazonaws.com/`.
 */
export function cognitoEndpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

/**
 * Calls one Cognito Identity Provider operation.
 *
 * Call: `callCognito(ctx, 'InitiateAuth', body)`.
 * Expects: an operation name and its JSON body.
 * Output: the response object on 2xx.
 * Throws: `CognitoError(type)` with the short error type (or
 * `HTTP_<status>`) on error; `NetworkError` from `requestJson`.
 */
export async function callCognito(ctx: CognitoContext, operation: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await requestJson(ctx.fetch, cognitoEndpoint(ctx.region), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
    },
    body,
  });
  if (r.status < 200 || r.status >= 300) {
    const type = (stringField(r.json, '__type') ?? '').split('#').pop();
    throw new CognitoError(type || `HTTP_${r.status}`);
  }
  return (r.json ?? {}) as Record<string, unknown>;
}

/**
 * Starts login: Cognito e-mails a one-time code.
 *
 * Call: `startEmailLogin(ctx, email)`.
 * Expects: a non-empty e-mail address.
 * Output: the pending login to pass to `confirmEmailCode`.
 * Throws: `CognitoError('BAD_EMAIL')` for an empty address,
 * `CognitoError('UNEXPECTED_CHALLENGE')` when Cognito asks for
 * anything but EMAIL_OTP, or errors from `callCognito`.
 */
export async function startEmailLogin(ctx: CognitoContext, email: string): Promise<PendingLogin> {
  const address = email.trim();
  if (!address.includes('@')) throw new CognitoError('BAD_EMAIL');
  const r = await callCognito(ctx, 'InitiateAuth', {
    AuthFlow: 'USER_AUTH',
    ClientId: ctx.clientId,
    AuthParameters: { USERNAME: address, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
  });
  const session = stringField(r, 'Session');
  if (r.ChallengeName !== 'EMAIL_OTP' || !session) throw new CognitoError('UNEXPECTED_CHALLENGE');
  return { email: address, session };
}

/**
 * Finishes login with the code from the e-mail.
 *
 * Call: `confirmEmailCode(ctx, pending, code)`.
 * Expects: the pending login from `startEmailLogin` (valid ~3 min).
 * Output: fresh tokens.
 * Throws: `CognitoError('WRONG_CODE')` for a wrong code (the user
 * may retry), `CODE_EXPIRED` / `SESSION_EXPIRED` when a new code is
 * needed, `UNEXPECTED_CHALLENGE` when Cognito asks for another step,
 * other `CognitoError`s, `NetworkError`. Spaces/dashes are ignored.
 */
export async function confirmEmailCode(ctx: CognitoContext, pending: PendingLogin, code: string): Promise<Tokens> {
  const digits = code.replace(/[\s-]/g, '');
  if (!/^\d{4,10}$/.test(digits)) throw new CognitoError('WRONG_CODE', 'FORMAT');
  let r: Record<string, unknown>;
  try {
    r = await callCognito(ctx, 'RespondToAuthChallenge', {
      ChallengeName: 'EMAIL_OTP',
      ClientId: ctx.clientId,
      Session: pending.session,
      ChallengeResponses: { USERNAME: pending.email, EMAIL_OTP_CODE: digits },
    });
  } catch (e) {
    throw mapConfirmError(e);
  }
  const tokens = tokensFromResult(r.AuthenticationResult, now(ctx));
  if (!tokens) throw new CognitoError('UNEXPECTED_CHALLENGE', String(r.ChallengeName ?? 'NO_TOKENS'));
  return tokens;
}

/**
 * Maps Cognito errors of the code step to user-facing codes.
 *
 * Call: `mapConfirmError(e)` in the catch of `confirmEmailCode`.
 * Expects: any thrown value.
 * Output: `WRONG_CODE` (mismatch), `CODE_EXPIRED` (expired code),
 * `SESSION_EXPIRED` (`NotAuthorizedException`), each with the original
 * type as detail; anything else is returned unchanged.
 */
function mapConfirmError(e: unknown): unknown {
  if (!(e instanceof CognitoError)) return e;
  const mapped: Record<string, string> = {
    CodeMismatchException: 'WRONG_CODE',
    ExpiredCodeException: 'CODE_EXPIRED',
    NotAuthorizedException: 'SESSION_EXPIRED',
  };
  const code = mapped[e.code];
  if (code) return new CognitoError(code, e.code);
  return e;
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * Call: `refreshTokens(ctx, refreshToken)`.
 * Expects: the stored refresh token.
 * Output: new tokens; the old refresh token is kept when Cognito does
 * not rotate it.
 * Throws: `CognitoError` (e.g. `NotAuthorizedException` when revoked),
 * `CognitoError('BAD_RESPONSE')` without an access token,
 * `NetworkError` when offline.
 */
export async function refreshTokens(ctx: CognitoContext, refreshToken: string): Promise<Tokens> {
  const r = await callCognito(ctx, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: ctx.clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  const tokens = tokensFromResult(r.AuthenticationResult, now(ctx), refreshToken);
  if (!tokens) throw new CognitoError('BAD_RESPONSE');
  return tokens;
}

/**
 * Converts a Cognito `AuthenticationResult` into `Tokens`.
 *
 * Call: `tokensFromResult(result, nowMs, previousRefresh?)`.
 * Expects: the raw result object (may be missing).
 * Output: tokens, or `null` without access or refresh token.
 * `ExpiresIn` defaults to 3600 s.
 */
export function tokensFromResult(result: unknown, nowMs: number, previousRefresh?: string): Tokens | null {
  const accessToken = stringField(result, 'AccessToken');
  const refreshToken = stringField(result, 'RefreshToken') ?? previousRefresh;
  if (!accessToken || !refreshToken) return null;
  const seconds = Number((result as Record<string, unknown>).ExpiresIn) || 3600;
  return { accessToken, refreshToken, expiresAt: nowMs + seconds * 1000 };
}

/**
 * Current time of a context.
 *
 * Call: `now(ctx)`.
 * Expects: a context with optional clock.
 * Output: epoch milliseconds.
 */
function now(ctx: CognitoContext): number {
  return (ctx.now ?? Date.now)();
}
