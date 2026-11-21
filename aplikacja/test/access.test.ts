import { describe, expect, it } from 'vitest';
import { accessMessage, ACCESS_EVERY_MS, checkAccess, isLicenceError, LOGOUT_REASONS } from '../src/logic/access.js';
import { ApiError, NetworkError } from '../src/logic/errors.js';
import { header, scriptedFetch } from './helpers.js';

const ID_URL = 'https://id.example.com';

describe('checkAccess', () => {
  it('sends_access_token_product_and_org', async () => {
    const f = scriptedFetch([{ status: 200, body: { active: true, sub: 'u', org: 'o', role: 'member', licenceUntil: 'x' } }]);
    expect(await checkAccess(f.fetch, ID_URL, 'ACCESS', 'pilot-bearly')).toEqual({ active: true });
    expect(f.calls[0]!.url).toBe(`${ID_URL}/access?product=cognifly&org=pilot-bearly`);
    expect(f.calls[0]!.init.method).toBe('GET');
    expect(header(f.calls[0]!, 'Authorization')).toBe('Bearer ACCESS');
  });

  it('parses_inactive_reason', async () => {
    const f = scriptedFetch([
      { status: 200, body: { active: false, reason: 'LICENCE_EXPIRED' } },
      { status: 200, body: { active: false, reason: 'bad reason <b>' } },
      { status: 200, body: { active: false } },
    ]);
    expect(await checkAccess(f.fetch, ID_URL, 'A', 'pilot')).toEqual({ active: false, reason: 'LICENCE_EXPIRED' });
    expect(await checkAccess(f.fetch, ID_URL, 'A', 'pilot')).toEqual({ active: false, reason: 'UNKNOWN' });
    expect(await checkAccess(f.fetch, ID_URL, 'A', 'pilot')).toEqual({ active: false, reason: 'UNKNOWN' });
  });

  it('encodes_the_org_in_the_query', async () => {
    const f = scriptedFetch([{ status: 200, body: { active: true } }]);
    await checkAccess(f.fetch, ID_URL, 'A', 'a&b c');
    expect(new URL(f.calls[0]!.url).searchParams.get('org')).toBe('a&b c');
  });

  it('non_200_is_network_error', async () => {
    const f = scriptedFetch([{ status: 401, body: {} }, { status: 500 }, { status: 200, body: { active: 'yes' } }, new TypeError('offline')]);
    for (let i = 0; i < 4; i++) await expect(checkAccess(f.fetch, ID_URL, 'A', 'pilot')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('accessMessage', () => {
  it('messages_are_polish', () => {
    expect(accessMessage('TOKEN_REVOKED')).toBe('Brak dostępu do CogniFly: sesja wygasła lub została unieważniona — zaloguj się ponownie.');
    expect(accessMessage('ACCOUNT_DISABLED')).toBe('Brak dostępu do CogniFly: konto jest wyłączone.');
    expect(accessMessage('NOT_MEMBER')).toBe('Brak dostępu do CogniFly: nie należysz już do firmy.');
    expect(accessMessage('ORG_SUSPENDED')).toBe('Brak dostępu do CogniFly: firma jest zawieszona.');
    expect(accessMessage('NO_LICENCE')).toBe('Brak dostępu do CogniFly: firma nie ma licencji na CogniFly.');
    expect(accessMessage('LICENCE_EXPIRED')).toBe('Brak dostępu do CogniFly: licencja firmy na CogniFly wygasła.');
    expect(accessMessage('ORG_REQUIRED')).toBe('Brak dostępu do CogniFly: należysz do kilku firm — wybierz firmę w ustawieniach CogniFly.');
    expect(accessMessage('MACHINE_REVOKED')).toBe('Brak dostępu do CogniFly: dostęp tego urządzenia został cofnięty.');
    expect(accessMessage('XYZ')).toBe('Brak dostępu do CogniFly: odmowa dostępu (XYZ).');
  });

  it('exports the constants of the plan', () => {
    expect(ACCESS_EVERY_MS).toBe(300_000);
    expect(LOGOUT_REASONS).toEqual(['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'NOT_MEMBER']);
  });

  it('recognises the licence codes of the API', () => {
    expect(isLicenceError(new ApiError(403, 'BRAK_LICENCJI'))).toBe(true);
    expect(isLicenceError(new ApiError(403, 'LICENCJA_WYGASLA'))).toBe(true);
    expect(isLicenceError(new ApiError(403, 'BRAK_DOSTEPU'))).toBe(false);
    expect(isLicenceError(new NetworkError())).toBe(false);
  });
});
