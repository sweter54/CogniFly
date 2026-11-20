// Dostęp do CogniFly według Platformy Identity (`GET /access?product=
// cognifly`): zapytanie, pamięć wyniku w ~/.cognifly/dostep.json (600,
// 5 min, per `sub`) i polskie teksty powodów. Bez zależności.
import { Stan, czytaj, zapisz, usun } from './sesja.mjs';

/** File with the last answer of Identity. */
const PLIK = 'dostep.json';

/** How long a stored answer is trusted, in ms. */
const WAZNOSC_MS = 300_000;

/** Reasons that end the session (sesja.json is deleted). */
const POWODY_WYLOGOWANIA = ['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'NOT_MEMBER'];

/** API codes of a missing or expired licence (403) → their reason. */
export const KODY_LICENCJI = { BRAK_LICENCJI: 'NO_LICENCE', LICENCJA_WYGASLA: 'LICENCE_EXPIRED' };

/** Shape of a reason code accepted from the network. */
const WZOR_POWODU = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Prefix of every reason text. */
const PREFIKS = 'Brak dostępu do CogniFly: ';

/** Polish texts of known reasons (same as in the desktop app). */
const TEKSTY = {
  TOKEN_REVOKED: 'sesja wygasła lub została unieważniona — zaloguj się ponownie.',
  ACCOUNT_DISABLED: 'konto jest wyłączone.',
  NOT_MEMBER: 'nie należysz już do firmy.',
  ORG_SUSPENDED: 'firma jest zawieszona.',
  NO_LICENCE: 'firma nie ma licencji na CogniFly.',
  LICENCE_EXPIRED: 'licencja firmy na CogniFly wygasła.',
};

/**
 * Polish text of a reason.
 *
 * Call: `komunikatDostepu('NO_LICENCE')`.
 * Expects: a reason code.
 * Output: `Brak dostępu do CogniFly: ` and the reason's text, or
 * `odmowa dostępu (<kod>).` for an unknown code.
 */
export function komunikatDostepu(powod) {
  return PREFIKS + (Object.hasOwn(TEKSTY, powod) ? TEKSTY[powod] : `odmowa dostępu (${powod}).`);
}

/**
 * Reads `sub` from a Cognito access token, without verification
 * (only to key the stored answer by account).
 *
 * Call: `subZTokenu(sesja.accessToken)`.
 * Expects: any value.
 * Output: the `sub` string, or null when the token is not a JWT.
 */
function subZTokenu(token) {
  try {
    const sub = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch { return null; }
}

/**
 * Stored answer for this account, if still valid.
 *
 * Call: `zPamieci(kat, sub)`.
 * Expects: the session directory and the account's `sub`.
 * Output: `{aktywny, powod?}` or null (none, stale, other account).
 * Throws: `Stan('ODMOWA')` when the file is a symlink.
 */
function zPamieci(kat, sub) {
  const z = czytaj(kat, PLIK);
  const wiek = Date.now() - Number(z?.czas);
  if (!sub || z?.sub !== sub || typeof z.aktywny !== 'boolean' || !(wiek >= 0 && wiek < WAZNOSC_MS)) return null;
  if (z.aktywny) return { aktywny: true };
  return { aktywny: false, powod: WZOR_POWODU.test(z.powod ?? '') ? z.powod : 'UNKNOWN' };
}

/**
 * Forgets the stored answer (licence refusal by the API, logout).
 *
 * Call: `zapomnijDostep(kat)`.
 * Expects: the session directory.
 * Output: none; a missing file is fine.
 * Throws: `Stan('ODMOWA')` when the file is a symlink.
 */
export function zapomnijDostep(kat) {
  usun(kat, PLIK);
}

/**
 * Asks Identity, at most once per 5 minutes per account.
 *
 * Call: `await sprawdzDostep({ kat, konf, sesja, signal })`.
 * Expects: `konf.adresTozsamosci` (empty → no check) and a session
 * with a fresh ACCESS token (never the ID token).
 * Output: `{aktywny: true}` or `{aktywny: false, powod}`. A network
 * error, a status other than 200 or a body without a boolean
 * `active` gives `{aktywny: true}` and nothing is stored; 200
 * answers are stored for 5 minutes under the token's `sub`.
 */
export async function sprawdzDostep({ kat, konf, sesja, signal }) {
  const adres = String(konf?.adresTozsamosci ?? '').replace(/\/+$/, '');
  if (!adres) return { aktywny: true };
  const sub = subZTokenu(sesja.accessToken);
  const pamiec = zPamieci(kat, sub);
  if (pamiec) return pamiec;
  let json;
  try {
    const r = await fetch(`${adres}/access?product=cognifly`, { headers: { Authorization: `Bearer ${sesja.accessToken}` }, signal });
    if (r.status !== 200) return { aktywny: true };
    json = await r.json();
  } catch { return { aktywny: true }; }
  if (typeof json?.active !== 'boolean') return { aktywny: true };
  const wynik = json.active ? { aktywny: true }
    : { aktywny: false, powod: WZOR_POWODU.test(json.reason ?? '') ? json.reason : 'UNKNOWN' };
  if (sub) zapisz(kat, PLIK, { sub, ...wynik, czas: Date.now() });
  return wynik;
}

/**
 * Error for an inactive access; ends the session when the reason
 * says so (revoked token, disabled account, not a member).
 *
 * Call: `throw odmowaDostepu(kat, 'NOT_MEMBER')`.
 * Expects: the session directory and a reason code.
 * Output: `Stan('BRAK_DOSTEPU_FIRMY', {powod, komunikat})`.
 */
export function odmowaDostepu(kat, powod) {
  if (POWODY_WYLOGOWANIA.includes(powod)) {
    usun(kat, 'sesja.json');
    zapomnijDostep(kat);
  }
  return new Stan('BRAK_DOSTEPU_FIRMY', { powod, komunikat: komunikatDostepu(powod) });
}

/**
 * Lets work go on only with an active access.
 *
 * Call: `await wymagajDostepu(ctx, sesja)` before a work command.
 * Expects: a context from `kontekst()` and the current session.
 * Output: none when access is active (or not checked).
 * Throws: `Stan('BRAK_DOSTEPU_FIRMY', {powod, komunikat})`.
 */
export async function wymagajDostepu(ctx, sesja) {
  const d = await sprawdzDostep({ kat: ctx.kat, konf: ctx.konf, sesja, signal: ctx.signal });
  if (!d.aktywny) throw odmowaDostepu(ctx.kat, d.powod);
}
