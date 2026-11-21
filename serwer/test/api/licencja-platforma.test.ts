import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { zapiszTozsamosc } from '../../src/dane/konfiguracja.js';
import { handler } from '../../src/api/index.js';
import { wyczyscPamiecDostepu } from '../../src/api/dostepPlatformy.js';
import { LICENCE_VALID } from './claims.js';

const tabela = ustawTabeleTestowa('cognifly-test-licencja-platforma');
const URL_TOZSAMOSCI = 'https://id.example.com';
const TOKEN = 'token-osoby';

beforeAll(async () => {
  await tabela.utworz();
  await zapiszTozsamosc('sub-michal', 'f1', 'michal');
  await zapiszTozsamosc('sub-michal', 'f2', 'michal');
});
afterAll(() => tabela.usun());

/** Body that times out while being read (headers came on time). */
const WOLNA_TRESC = Symbol('wolna treść');
/** 200 with a body that is not JSON. */
const ZLY_JSON = Symbol('zły JSON');

/** Answers of Platforma `/access` per org; an Error fails like the network. */
let odpowiedzi: Record<string, unknown>;
const fetchMock = vi.fn(async (url: string) => {
  const org = new URL(url).searchParams.get('org') ?? '';
  const o = odpowiedzi[org] ?? { active: true };
  if (o instanceof Error) throw o;
  if (typeof o === 'number') return new Response('{}', { status: o });
  if (o === WOLNA_TRESC) {
    const blad = Object.assign(new Error('body timeout'), { name: 'TimeoutError' });
    return { status: 200, text: async () => { throw blad; }, json: async () => { throw blad; } } as unknown as Response;
  }
  if (o === ZLY_JSON) return new Response('nie json', { status: 200 });
  return new Response(JSON.stringify(o), { status: 200 });
});

beforeEach(() => {
  process.env.TOZSAMOSC_URL = URL_TOZSAMOSCI;
  odpowiedzi = {};
  fetchMock.mockClear();
  wyczyscPamiecDostepu();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  delete process.env.TOZSAMOSC_URL;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** API event with the person's token, an optional company header and claims. */
const call = (routeKey: string, firma: string | undefined, claims: Record<string, unknown> = {}, token = TOKEN) => handler({
  routeKey,
  headers: { authorization: `Bearer ${token}`, ...(firma === undefined ? {} : { 'x-cognifly-firma': firma }) },
  queryStringParameters: {}, pathParameters: {}, body: null,
  requestContext: { authorizer: { jwt: { claims: { sub: 'sub-michal', ...claims } } } },
});
const kod = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const orgi = () => fetchMock.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('org'));

describe('licence without the claim (person in several companies)', () => {
  test('asks_platforma_with_the_persons_token_for_the_header_company', async () => {
    const r = await call('GET /skrzynka', 'f2');
    expect(r.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_TOZSAMOSCI}/access?product=cognifly&org=f2`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('claim_for_the_same_company_skips_platforma', async () => {
    const r = await call('GET /skrzynka', 'f1', { lic_cognifly: LICENCE_VALID, org: 'f1' });
    expect(r.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const stary = await call('GET /skrzynka', 'f1', { lic_cognifly: '2020-01-01T00:00:00+00:00', org: 'f1' });
    expect(kod(stary)).toEqual({ kod: 'LICENCJA_WYGASLA' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('claim_for_another_company_asks_platforma', async () => {
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    const r = await call('GET /skrzynka', 'f2', { lic_cognifly: LICENCE_VALID, org: 'f1' });
    expect(r.statusCode).toBe(403);
    expect(kod(r)).toEqual({ kod: 'BRAK_LICENCJI' });
    expect(orgi()).toEqual(['f2']);
  });

  test('platforma_refusals_map_to_403_codes', async () => {
    odpowiedzi.f1 = { active: false, reason: 'LICENCE_EXPIRED' };
    expect(kod(await call('GET /skrzynka', 'f1'))).toEqual({ kod: 'LICENCJA_WYGASLA' });
    odpowiedzi.f2 = { active: false, reason: 'ORG_SUSPENDED' };
    const r = await call('GET /skrzynka', 'f2');
    expect(r.statusCode).toBe(403);
    expect(kod(r)).toEqual({ kod: 'BRAK_DOSTEPU', powod: 'ORG_SUSPENDED' });
    wyczyscPamiecDostepu();
    odpowiedzi.f2 = { active: false, reason: 'zły <b>' };
    expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'BRAK_DOSTEPU', powod: 'UNKNOWN' });
  });

  test('answer_cached_5_minutes_per_token_and_company', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await call('GET /skrzynka', 'f2');
    await call('GET /skrzynka', 'f2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await call('GET /skrzynka', 'f1');
    await call('GET /skrzynka', 'f2', {}, 'inny-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 300_000);
    await call('GET /skrzynka', 'f2');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test('refusal_is_cached_too', async () => {
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    await call('GET /skrzynka', 'f2');
    odpowiedzi.f2 = { active: true };
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('network_error_without_a_remembered_answer_lets_the_request_through_uncached', async () => {
    odpowiedzi.f2 = new TypeError('offline');
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(200);
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('5xx_and_429_without_a_remembered_answer_let_the_request_through', async () => {
    for (const status of [500, 503, 429]) {
      odpowiedzi.f2 = status;
      expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('4xx_answer_refuses_with_503_tozsamosc_niedostepna', async () => {
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of [400, 401, 403, 404]) {
      odpowiedzi.f2 = status;
      const r = await call('GET /skrzynka', 'f2');
      expect(r.statusCode).toBe(503);
      expect(kod(r)).toEqual({ kod: 'TOZSAMOSC_NIEDOSTEPNA' });
    }
    expect(blad).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    blad.mockRestore();
  });

  test('malformed_body_refuses_with_503_tozsamosc_niedostepna', async () => {
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    odpowiedzi.f2 = { active: 'tak' };
    const r = await call('GET /skrzynka', 'f2');
    expect(r.statusCode).toBe(503);
    expect(kod(r)).toEqual({ kod: 'TOZSAMOSC_NIEDOSTEPNA' });
    expect(blad).toHaveBeenCalled();
    blad.mockRestore();
  });

  test('stale_if_error_uses_the_last_answer_up_to_60_minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'BRAK_LICENCJI' });
    for (const [po, awaria] of [[6, new TypeError('offline')], [30, 502], [59, 429]] as const) {
      vi.setSystemTime(t0 + po * 60_000);
      odpowiedzi.f2 = awaria;
      expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'BRAK_LICENCJI' });
    }
    vi.setSystemTime(t0 + 60 * 60_000);
    odpowiedzi.f2 = new TypeError('offline');
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('stale_if_error_survives_a_token_refresh_of_the_same_person', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    expect(kod(await call('GET /skrzynka', 'f2', {}, 'token-1'))).toEqual({ kod: 'BRAK_LICENCJI' });
    vi.setSystemTime(t0 + 30 * 60_000);
    odpowiedzi.f2 = new TypeError('offline');
    const r = await call('GET /skrzynka', 'f2', {}, 'token-2');
    expect(r.statusCode).toBe(403);
    expect(kod(r)).toEqual({ kod: 'BRAK_LICENCJI' });
  });

  test('fallback_is_per_person_and_company', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    await call('GET /skrzynka', 'f2', {}, 'token-1');
    vi.setSystemTime(Date.now() + 6 * 60_000);
    odpowiedzi.f2 = new TypeError('offline');
    odpowiedzi.f1 = new TypeError('offline');
    expect((await call('GET /skrzynka', 'f1', {}, 'token-2')).statusCode).toBe(200);
  });

  test('token_reasons_are_not_kept_as_fallback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const reason of ['TOKEN_REVOKED', 'ACCOUNT_DISABLED']) {
      wyczyscPamiecDostepu();
      odpowiedzi.f2 = { active: false, reason };
      expect((await call('GET /skrzynka', 'f2', {}, 'token-1')).statusCode).toBe(403);
      odpowiedzi.f2 = new TypeError('offline');
      expect((await call('GET /skrzynka', 'f2', {}, 'token-2')).statusCode).toBe(200);
    }
  });

  test('slow_body_counts_as_an_outage_and_uses_the_fallback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    odpowiedzi.f2 = WOLNA_TRESC;
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(200);
    odpowiedzi.f2 = { active: false, reason: 'LICENCE_EXPIRED' };
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await call('GET /skrzynka', 'f2');
    vi.setSystemTime(Date.now() + 6 * 60_000);
    odpowiedzi.f2 = WOLNA_TRESC;
    expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'LICENCJA_WYGASLA' });
    expect(blad).not.toHaveBeenCalled();
    blad.mockRestore();
  });

  test('unparsable_json_refuses_with_503', async () => {
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    odpowiedzi.f2 = ZLY_JSON;
    expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'TOZSAMOSC_NIEDOSTEPNA' });
    expect(blad).toHaveBeenCalled();
    blad.mockRestore();
  });

  test('stale_answer_is_not_used_for_a_4xx', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const blad = vi.spyOn(console, 'error').mockImplementation(() => {});
    await call('GET /skrzynka', 'f2');
    vi.setSystemTime(Date.now() + 6 * 60_000);
    odpowiedzi.f2 = 401;
    expect((await call('GET /skrzynka', 'f2')).statusCode).toBe(503);
    blad.mockRestore();
  });

  test('bearer_scheme_is_case_insensitive', async () => {
    const r = await handler({
      routeKey: 'GET /skrzynka', headers: { authorization: `bearer  ${TOKEN}`, 'x-cognifly-firma': 'f2' },
      queryStringParameters: {}, pathParameters: {}, body: null,
      requestContext: { authorizer: { jwt: { claims: { sub: 'sub-michal' } } } },
    });
    expect(r.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('ja_with_a_stale_header_passes_when_any_company_is_licensed', async () => {
    odpowiedzi.f1 = { active: false, reason: 'NO_LICENCE' };
    const r = await call('GET /ja', 'stara');
    expect(r.statusCode).toBe(200);
    expect(orgi()).toEqual(['f1', 'f2']);
  });

  test('ja_refuses_with_the_first_refusal_when_no_company_is_licensed', async () => {
    odpowiedzi.f1 = { active: false, reason: 'LICENCE_EXPIRED' };
    odpowiedzi.f2 = { active: false, reason: 'NO_LICENCE' };
    expect(kod(await call('GET /ja', undefined))).toEqual({ kod: 'LICENCJA_WYGASLA' });
  });

  test('without_identity_url_or_token_only_the_claim_counts', async () => {
    delete process.env.TOZSAMOSC_URL;
    expect(kod(await call('GET /skrzynka', 'f2'))).toEqual({ kod: 'BRAK_LICENCJI' });
    process.env.TOZSAMOSC_URL = URL_TOZSAMOSCI;
    expect(kod(await call('GET /skrzynka', 'f2', {}, ''))).toEqual({ kod: 'BRAK_LICENCJI' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
