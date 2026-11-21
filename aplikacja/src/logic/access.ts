// Access to CogniFly as the Platforma Identity service sees it
// (`GET /access?product=cognifly&org=<company>`): the request, the reasons that
// end the session and the Polish texts shown to the user.
import { ApiError, NetworkError } from './errors.js';
import { requestJson, stringField, type FetchFn } from './http.js';

/** Answer of Identity: active, or inactive with a reason code. */
export type Access = { active: true } | { active: false; reason: string };

/**
 * Fit of the stored company with the person's companies: `member`
 * (kept), `switched` (moved to their only company) or `choose`
 * (several companies: work stops until they pick one).
 */
export type CompanyFit = 'member' | 'switched' | 'choose';

/** How often (and how long a result is trusted), in ms. */
export const ACCESS_EVERY_MS = 300_000;

/** Reasons that end the session (login screen with the reason). */
export const LOGOUT_REASONS: readonly string[] = ['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'NOT_MEMBER'];

/** API codes of a missing or expired licence (403) → their reason. */
const LICENCE_REASONS: Record<string, string> = { BRAK_LICENCJI: 'NO_LICENCE', LICENCJA_WYGASLA: 'LICENCE_EXPIRED' };

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
  ORG_REQUIRED: 'należysz do kilku firm — wybierz firmę w ustawieniach CogniFly.',
  MACHINE_REVOKED: 'dostęp tego urządzenia został cofnięty.',
};

/**
 * Asks Identity whether the user may use CogniFly in a company.
 *
 * Call: `await checkAccess(fetch, config.identityUrl, token, company)`.
 * Expects: the Identity base URL (no trailing `/`), the Cognito
 * ACCESS token (never the ID token) and the company id. The company
 * is always sent: a person in several companies gets `ORG_REQUIRED`
 * without it.
 * Output: `{ active: true }` or `{ active: false, reason }`.
 * Throws: `NetworkError` on a connection failure, a status other
 * than 200 or a body without a boolean `active`.
 */
export async function checkAccess(
  fetchFn: FetchFn, identityUrl: string, accessToken: string, company: string,
): Promise<Access> {
  const query = new URLSearchParams({ product: 'cognifly', org: company });
  const r = await requestJson(fetchFn, `${identityUrl}/access?${query}`, {
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
export function isLicenceError(e: unknown): e is ApiError {
  return e instanceof ApiError && Object.hasOwn(LICENCE_REASONS, e.code);
}

/**
 * Polish text of an API licence code.
 *
 * Call: `licenceMessage('BRAK_LICENCJI')`.
 * Expects: `BRAK_LICENCJI` or `LICENCJA_WYGASLA`.
 * Output: the text of `NO_LICENCE` / `LICENCE_EXPIRED`; another
 * code gets the "odmowa dostępu (<code>)" text.
 */
export function licenceMessage(code: string): string {
  return accessMessage(LICENCE_REASONS[code] ?? code);
}

/**
 * Polish text of an automatic move to the person's only company.
 *
 * Call: `companySwitchedMessage('pilot', 'acme')`.
 * Expects: the left company and the new one.
 * Output: one sentence for the notification.
 */
export function companySwitchedMessage(left: string, now: string): string {
  return `Nie należysz już do firmy ${left} — przełączono na firmę ${now}.`;
}

/**
 * Polish text shown while the person must choose a company.
 *
 * Call: `companyChoiceMessage('pilot')`.
 * Expects: the company the person left.
 * Output: one sentence for the banner.
 */
export function companyChoiceMessage(left: string): string {
  return `Nie należysz już do firmy ${left} — wybierz firmę w Ustawieniach.`;
}
