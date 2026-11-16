// Non-secret connection settings. Defaults point at the pilot stack;
// only the public Cognito client id is embedded (no secrets).
import { readJson, writeJson, type KeyValueStore } from './storage.js';

/** Connection settings of the app. */
export interface AppConfig {
  apiUrl: string;
  clientId: string;
  region: string;
  company: string;
}

/** Pilot deployment (test account, eu-central-1). */
export const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  apiUrl: 'https://td5k44easl.execute-api.eu-central-1.amazonaws.com',
  clientId: '67b7re8ou041svoosk3ukotqrq',
  region: 'eu-central-1',
  company: 'pilot',
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
 * Output: `{ ok: true, config }` with the API URL stripped of trailing
 * slashes, or `{ ok: false, field }` naming the first invalid field.
 * Rules: API URL must be https without credentials/query/fragment;
 * client id alphanumeric; region like `eu-central-1`; company
 * lowercase letters, digits and dashes (may be empty).
 */
export function validateConfig(input: unknown): ConfigCheck {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const config: AppConfig = {
    apiUrl: text('apiUrl').replace(/\/+$/, ''),
    clientId: text('clientId'),
    region: text('region'),
    company: text('company'),
  };
  if (!isSafeHttpsUrl(config.apiUrl)) return { ok: false, field: 'apiUrl' };
  if (!CLIENT_ID.test(config.clientId)) return { ok: false, field: 'clientId' };
  if (!REGION.test(config.region)) return { ok: false, field: 'region' };
  if (!COMPANY.test(config.company)) return { ok: false, field: 'company' };
  return { ok: true, config };
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
  if (!/^https:\/\/\S+$/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Loads saved settings.
 *
 * Call: `loadConfig(store)`.
 * Expects: any store; invalid saved data is ignored.
 * Output: the saved, valid config, otherwise a copy of the defaults.
 */
export function loadConfig(store: KeyValueStore): AppConfig {
  const check = validateConfig(readJson(store, STORE_KEY));
  return check.ok ? check.config : { ...DEFAULT_CONFIG };
}

/**
 * Validates and saves settings.
 *
 * Call: `saveConfig(store, input)` from the settings form.
 * Expects: raw form values.
 * Output: the validation result; the config is stored only when valid.
 */
export function saveConfig(store: KeyValueStore, input: unknown): ConfigCheck {
  const check = validateConfig(input);
  if (check.ok) writeJson(store, STORE_KEY, check.config);
  return check;
}
