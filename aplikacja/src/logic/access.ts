// Access to CogniFly as the Platforma Identity service sees it
// (`GET /access?product=cognifly`): the request, the reasons that
// end the session and the Polish texts shown to the user.
import { ApiError, NetworkError } from './errors.js';
import { requestJson, stringField, type FetchFn } from './http.js';

/** Answer of Identity: active, or inactive with a reason code. */
export type Access = { active: true } | { active: false; reason: string };

/** How often (and how long a result is trusted), in ms. */
export const ACCESS_EVERY_MS = 300_000;

/** Reasons that end the session (login screen with the reason). */
export const LOGOUT_REASONS: readonly string[] = ['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'NOT_MEMBER'];

/** API codes of a missing or expired company licence (403). */
const LICENCE_ERRORS: readonly string[] = ['BRAK_LICENCJI', 'LICENCJA_WYGASLA'];

/** Reason used when Identity sends none or an odd one. */
const UNKNOWN_REASON = 'UNKNOWN';

/** Shape of a reason code accepted from the network. */
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Prefix of every reason text. */
const PREFIX = 'Brak dostępu do CogniFly: ';

/** Polish texts of known reasons (shared with the plugin). */
const REASON_TEXTS: Record<string, string> = {
  TOKEN_REVOKED: 'sesja wygasła lub została unieważniona — zaloguj się ponownie.',
  ACCOUNT_DISABLED: 'konto jest wyłączone.',
  NOT_MEMBER: 'nie należysz już do firmy.',
  ORG_SUSPENDED: 'firma jest zawieszona.',
  NO_LICENCE: 'firma nie ma licencji na CogniFly.',
  LICENCE_EXPIRED: 'licencja firmy na CogniFly wygasła.',
};

/**
 * Asks Identity whether the user may use CogniFly.
 *
 * Call: `await checkAccess(fetch, config.identityUrl, accessToken)`.
 * Expects: the Identity base URL (no trailing `/`) and the Cognito
 * ACCESS token (never the ID token).
 * Output: `{ active: true }` or `{ active: false, reason }`.
 * Throws: `NetworkError` on a connection failure, a status other
 * than 200 or a body without a boolean `active`.
 */
export async function checkAccess(fetchFn: FetchFn, identityUrl: string, accessToken: string): Promise<Access> {
  const r = await requestJson(fetchFn, `${identityUrl}/access?product=cognifly`, {
    method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status !== 200) throw new NetworkError();
  return parseAccess(r.json);
}

/**
 * Reads the body of `GET /access`.
 *
 * Call: `parseAccess(json)`.
 * Expects: anything.
 * Output: the access; a missing or malformed reason becomes
 * `UNKNOWN`, so network text never reaches the screen as is.
 * Throws: `NetworkError` when `active` is not a boolean.
 */
function parseAccess(json: unknown): Access {
  const active = typeof json === 'object' && json !== null ? (json as Record<string, unknown>).active : undefined;
  if (active === true) return { active: true };
  if (active !== false) throw new NetworkError();
  const reason = stringField(json, 'reason');
  return { active: false, reason: reason && REASON_PATTERN.test(reason) ? reason : UNKNOWN_REASON };
}

/**
 * Polish text of a reason.
 *
 * Call: `accessMessage(reason)`.
 * Expects: a reason code.
 * Output: `Brak dostępu do CogniFly: ` and the reason's text, or
 * `odmowa dostępu (<code>).` for an unknown code.
 */
export function accessMessage(reason: string): string {
  return PREFIX + (REASON_TEXTS[reason] ?? `odmowa dostępu (${reason}).`);
}

/**
 * Tells whether the API refused for lack of a valid licence.
 *
 * Call: `isLicenceError(e)` in catch blocks.
 * Expects: anything thrown.
 * Output: true for `ApiError` `BRAK_LICENCJI` / `LICENCJA_WYGASLA`.
 */
export function isLicenceError(e: unknown): boolean {
  return e instanceof ApiError && LICENCE_ERRORS.includes(e.code);
}
