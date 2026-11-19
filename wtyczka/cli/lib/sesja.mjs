// Sesja i pliki w ~/.cognifly (600), logowanie Cognito (EMAIL_OTP). Bez zależności.
import { lstatSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export class Stan extends Error {
  constructor(stan, dane = {}) { super(stan); this.stan = stan; this.dane = dane; }
}

export const katalog = (env = process.env) => env.COGNIFLY_KATALOG || join(homedir(), '.cognifly');

export function przygotujKatalog(kat) {
  let st = null;
  try { st = lstatSync(kat); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Stan('ODMOWA');
  if (!st) mkdirSync(kat, { recursive: true, mode: 0o700 });
  chmodSync(kat, 0o700);
}

function sprawdz(plik) {
  try {
    const st = lstatSync(plik);
    if (st.isSymbolicLink() || !st.isFile()) throw new Stan('ODMOWA');
    return true;
  } catch (e) {
    if (e instanceof Stan) throw e;
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

export function czytaj(kat, nazwa) {
  const plik = join(kat, nazwa);
  if (!sprawdz(plik)) return null;
  try { return JSON.parse(readFileSync(plik, 'utf8')); } catch { return null; }
}

export function zapisz(kat, nazwa, obj) {
  przygotujKatalog(kat);
  const plik = join(kat, nazwa);
  sprawdz(plik);
  const tmp = join(kat, `.${nazwa}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(obj)); } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, plik);
}

export function usun(kat, nazwa) {
  const plik = join(kat, nazwa);
  if (sprawdz(plik)) unlinkSync(plik);
}

// --- Cognito JSON API ---
export function punktCognito(konf, env = process.env) {
  return env.COGNIFLY_COGNITO_ENDPOINT || `https://cognito-idp.${konf.region}.amazonaws.com/`;
}

export async function cognito(endpoint, operacja, body, signal) {
  let r;
  try {
    r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operacja}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch { throw new Stan('BLAD_SIECI'); }
  let json = {};
  try { json = await r.json(); } catch {
    if (r.ok) throw new Stan(signal?.aborted ? 'BLAD_SIECI' : 'BLAD', signal?.aborted ? {} : { kod: 'ZLA_ODPOWIEDZ' });
  }
  if (!r.ok) {
    const typ = String(json.__type ?? '').split('#').pop();
    return { blad: typ || `HTTP_${r.status}` };
  }
  return { ok: json };
}

const TRZY_MIN = 3 * 60_000;

export async function zaloguj({ kat, konf, endpoint, email, signal }) {
  if (!email) throw new Stan('BLAD', { kod: 'BRAK_EMAIL' });
  const r = await cognito(endpoint, 'InitiateAuth', {
    AuthFlow: 'USER_AUTH', ClientId: konf.klientCognito,
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
  }, signal);
  if (r.blad) throw new Stan('BLAD', { kod: r.blad });
  if (r.ok.ChallengeName !== 'EMAIL_OTP' || !r.ok.Session) throw new Stan('BLAD', { kod: 'NIEOCZEKIWANE_WYZWANIE' });
  zapisz(kat, 'oczekujace.json', { email, session: r.ok.Session, wygasa: Date.now() + TRZY_MIN });
  return { stan: 'KOD_WYSLANY' };
}

function sesjaZWyniku(w, stara, klient) {
  return {
    klient,
    accessToken: w.AccessToken,
    idToken: w.IdToken ?? stara?.idToken,
    refreshToken: w.RefreshToken ?? stara?.refreshToken,
    wygasa: Date.now() + (Number(w.ExpiresIn) || 3600) * 1000,
  };
}

export async function kod({ kat, konf, endpoint, kod: k, signal }) {
  const p = czytaj(kat, 'oczekujace.json');
  if (!p || !p.session || !(p.wygasa > Date.now())) {
    usun(kat, 'oczekujace.json');
    throw new Stan('WYMAGA_LOGOWANIA');
  }
  if (!k) throw new Stan('ZLY_KOD');
  const r = await cognito(endpoint, 'RespondToAuthChallenge', {
    ChallengeName: 'EMAIL_OTP', ClientId: konf.klientCognito, Session: p.session,
    ChallengeResponses: { USERNAME: p.email, EMAIL_OTP_CODE: String(k) },
  }, signal);
  if (r.blad) {
    if (r.blad === 'CodeMismatchException' || r.blad === 'ExpiredCodeException') throw new Stan('ZLY_KOD');
    usun(kat, 'oczekujace.json');
    if (r.blad === 'NotAuthorizedException') throw new Stan('WYMAGA_LOGOWANIA');
    throw new Stan('BLAD', { kod: r.blad });
  }
  if (!r.ok.AuthenticationResult?.AccessToken) throw new Stan('ZLY_KOD');
  zapisz(kat, 'sesja.json', sesjaZWyniku(r.ok.AuthenticationResult, undefined, konf.klientCognito));
  usun(kat, 'oczekujace.json');
  return { stan: 'ZALOGOWANO', osoba: p.email, firmy: konf.firmaDomyslna ? [konf.firmaDomyslna] : [] };
}

export async function odswiez({ kat, konf, endpoint, sesja, signal }) {
  const r = await cognito(endpoint, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: konf.klientCognito,
    AuthParameters: { REFRESH_TOKEN: sesja.refreshToken },
  }, signal);
  if (r.blad) {
    if (r.blad === 'NotAuthorizedException' || r.blad === 'UserNotFoundException') {
      usun(kat, 'sesja.json');
      throw new Stan('WYMAGA_LOGOWANIA');
    }
    throw new Stan('BLAD', { kod: r.blad });
  }
  if (!r.ok.AuthenticationResult?.AccessToken) throw new Stan('BLAD', { kod: 'ZLA_ODPOWIEDZ' });
  const nowa = sesjaZWyniku(r.ok.AuthenticationResult, sesja, konf.klientCognito);
  zapisz(kat, 'sesja.json', nowa);
  return nowa;
}

export function wyloguj(kat) {
  usun(kat, 'sesja.json');
  usun(kat, 'oczekujace.json');
  return { stan: 'WYLOGOWANO' };
}
