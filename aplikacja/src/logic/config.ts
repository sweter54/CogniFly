// Non-secret settings. Connection values (API, Cognito client, region)
// are built into the app (today: the pilot stack; later one build per
// company) and cannot be changed by users. Only the user's choices —
// company and work folder — are stored.
import { readJson, writeJson, type KeyValueStore } from './storage.js';

/** Connection settings of the app. */
export interface AppConfig {
  apiUrl: string;
  clientId: string;
  region: string;
  company: string;
  /** Optional absolute folder for Claude Code sessions (`''` = none). */
  workFolder: string;
  /** Heartwood server (https; `''` = files disabled, D10). */
  heartwoodUrl: string;
  /** Heartwood WebSocket (wss; `''` = files disabled, D10). */
  heartwoodWsUrl: string;
}

/** Built-in connection (pilot: test account, eu-central-1). */
export const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  apiUrl: 'https://td5k44easl.execute-api.eu-central-1.amazonaws.com',
  clientId: '67b7re8ou041svoosk3ukotqrq',
  region: 'eu-central-1',
  company: 'pilot',
  workFolder: '',
  // Heartwood test (stack heartwood-test, Heartwood repo); same pool.
  heartwoodUrl: 'https://eohqtq0t3j.execute-api.eu-central-1.amazonaws.com',
  heartwoodWsUrl: 'wss://s0ulscfugh.execute-api.eu-central-1.amazonaws.com/prod',
});

const STORE_KEY = 'cognifly.config';
const CLIENT_ID = /^[A-Za-z0-9]{1,128}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const COMPANY = /^[a-z0-9-]{0,40}$/;

/** Result of validation: the cleaned config or the first bad field. */
export type ConfigCheck =
  | { ok: true; config: AppConfig }
  | { ok: false; field: keyof AppConfig };

/**
 * Validates and normalises user-entered settings.
 *
 * Call: `validateConfig(input)` with form values or stored JSON.
 * Expects: anything; strings are trimmed.
 * Output: `{ ok: true, config }` with URLs stripped of trailing
 * slashes, or `{ ok: false, field }` naming the first invalid field.
 * Rules: API URL must be https without credentials/query/fragment;
 * Heartwood URLs empty or likewise (https, and wss for the socket);
 * client id alphanumeric; region like `eu-central-1`; company
 * lowercase letters, digits and dashes (may be empty); work folder
 * empty or a safe absolute path (see `isSafeFolder`).
 */
export function validateConfig(input: unknown): ConfigCheck {
  const config: AppConfig = {
    apiUrl: trimmedField(input, 'apiUrl').replace(/\/+$/, ''),
    clientId: trimmedField(input, 'clientId'),
    region: trimmedField(input, 'region'),
    company: trimmedField(input, 'company'),
    workFolder: trimmedField(input, 'workFolder').replace(/(.)\/+$/, '$1'),
    heartwoodUrl: trimmedField(input, 'heartwoodUrl').replace(/\/+$/, ''),
    heartwoodWsUrl: trimmedField(input, 'heartwoodWsUrl').replace(/\/+$/, ''),
  };
  if (!isSafeHttpsUrl(config.apiUrl)) return { ok: false, field: 'apiUrl' };
  if (!CLIENT_ID.test(config.clientId)) return { ok: false, field: 'clientId' };
  if (!REGION.test(config.region)) return { ok: false, field: 'region' };
  if (!COMPANY.test(config.company)) return { ok: false, field: 'company' };
  if (config.workFolder && !isSafeFolder(config.workFolder)) return { ok: false, field: 'workFolder' };
  if (config.heartwoodUrl && !isSafeHttpsUrl(config.heartwoodUrl)) return { ok: false, field: 'heartwoodUrl' };
  if (config.heartwoodWsUrl && !isSafeUrl(config.heartwoodWsUrl, 'wss:')) return { ok: false, field: 'heartwoodWsUrl' };
  return { ok: true, config };
}

/**
 * Reads a trimmed string field.
 *
 * Call: `trimmedField(input, 'region')`.
 * Expects: anything as `input`.
 * Output: the trimmed string, or `''` when missing or not a string.
 */
function trimmedField(input: unknown, name: keyof AppConfig): string {
  if (typeof input !== 'object' || input === null) return '';
  const v = (input as Record<string, unknown>)[name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Checks that a string is a plain https base URL.
 *
 * Call: `isSafeHttpsUrl(url)`.
 * Expects: any string.
 * Output: `true` only for parsable `https:` URLs without user info,
 * query string or fragment.
 */
export function isSafeHttpsUrl(url: string): boolean {
  return isSafeUrl(url, 'https:');
}

/**
 * Checks that a string is a plain base URL of one scheme.
 *
 * Call: `isSafeUrl(url, 'wss:')`.
 * Expects: any string; a protocol like `https:` or `wss:`.
 * Output: `true` only for parsable URLs of that protocol without
 * user info, query string or fragment.
 */
function isSafeUrl(url: string, protocol: string): boolean {
  if (!url.startsWith(`${protocol}//`) || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === protocol && !!u.host && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Checks a work folder path.
 *
 * Call: `isSafeFolder(path)`.
 * Expects: a trimmed string.
 * Output: `true` for an absolute path (`/…`) of at most 1024
 * characters without `..` segments or control characters.
 */
export function isSafeFolder(path: string): boolean {
  if (!path.startsWith('/') || path.length > 1024) return false;
  if (/[\p{Cc}]/u.test(path)) return false;
  return !path.split('/').includes('..');
}

/** The user's own choices (the only stored part of the config). */
export type UserChoices = Pick<AppConfig, 'company' | 'workFolder'>;

/**
 * Loads the config: built-in connection + stored user choices.
 *
 * Call: `loadConfig(store)`.
 * Expects: any store; invalid stored choices are ignored. Stored
 * connection values from older versions are ignored too.
 * Output: a valid config.
 */
export function loadConfig(store: KeyValueStore): AppConfig {
  const saved = readJson(store, STORE_KEY);
  const merged = {
    ...DEFAULT_CONFIG,
    company: trimmedField(saved, 'company') || DEFAULT_CONFIG.company,
    workFolder: trimmedField(saved, 'workFolder'),
  };
  const check = validateConfig(merged);
  return check.ok ? check.config : { ...DEFAULT_CONFIG };
}

/**
 * Validates and stores the user's choices.
 *
 * Call: `saveChoices(store, { company, workFolder })`.
 * Expects: values chosen in the app.
 * Output: the full config (built-in connection + choices), or the
 * first invalid field; only valid choices are stored.
 */
export function saveChoices(store: KeyValueStore, choices: UserChoices): ConfigCheck {
  const check = validateConfig({ ...DEFAULT_CONFIG, ...choices });
  if (check.ok) writeJson(store, STORE_KEY, { company: check.config.company, workFolder: check.config.workFolder });
  return check;
}
