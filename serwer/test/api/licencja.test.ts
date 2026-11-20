import { afterEach, beforeAll, afterAll, describe, expect, test } from 'vitest';
import { ustawTabeleTestowa } from '../dane/pomocnik.js';
import { zapiszTozsamosc } from '../../src/dane/konfiguracja.js';
import { handler } from '../../src/api/index.js';
import { licenceState } from '../../src/api/kontekst.js';
import { claimsFor } from './claims.js';

const tabela = ustawTabeleTestowa('cognifly-test-licencja');
beforeAll(async () => {
  await tabela.utworz();
  await zapiszTozsamosc('sub-michal', 'f1', 'michal');
});
afterAll(() => tabela.usun());
afterEach(() => { delete process.env.COGNIFLY_LICENCE_CLAIM; });

const T = '2026-11-20T00:00:00+00:00';
const t = Date.parse(T);

describe('licenceState', () => {
  test('licence_valid_before_claim', () => {
    expect(licenceState({ lic_cognifly: T }, t - 1)).toBe('OK');
  });
  test('licence_expired_when_now_equals_claim', () => {
    expect(licenceState({ lic_cognifly: T }, t)).toBe('LICENCJA_WYGASLA');
    expect(licenceState({ lic_cognifly: T }, t + 1)).toBe('LICENCJA_WYGASLA');
  });
  test('missing_or_unparsable_claim_is_no_licence', () => {
    for (const c of [undefined, {}, { lic_cognifly: '' }, { lic_cognifly: 'abc' }, { lic_cognifly: 5 }, { lic_cognifly: null }]) {
      expect(licenceState(c as Record<string, unknown> | undefined, t)).toBe('BRAK_LICENCJI');
    }
  });
  test('claim name comes from COGNIFLY_LICENCE_CLAIM', () => {
    process.env.COGNIFLY_LICENCE_CLAIM = 'lic_x';
    expect(licenceState({ lic_x: T }, t - 1)).toBe('OK');
    expect(licenceState({ lic_cognifly: T }, t - 1)).toBe('BRAK_LICENCJI');
  });
});

const call = (routeKey: string, claims: Record<string, unknown>) => handler({
  routeKey, headers: {}, queryStringParameters: {}, pathParameters: {}, body: null,
  requestContext: { authorizer: { jwt: { claims } } },
});

describe('routes', () => {
  test('route_returns_403_licencja_wygasla', async () => {
    const r = await call('GET /skrzynka', { sub: 'sub-michal', lic_cognifly: '2020-01-01T00:00:00+00:00' });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ kod: 'LICENCJA_WYGASLA' });
  });
  test('route_returns_403_brak_licencji without claim', async () => {
    const r = await call('GET /skrzynka', { sub: 'sub-michal' });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ kod: 'BRAK_LICENCJI' });
  });
  test('firmyZTokenu route (GET /ja) also refuses', async () => {
    const r = await call('GET /ja', { sub: 'sub-michal' });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ kod: 'BRAK_LICENCJI' });
  });
  test('route_works_with_valid_licence', async () => {
    expect((await call('GET /skrzynka', claimsFor('sub-michal'))).statusCode).toBe(200);
  });
});
