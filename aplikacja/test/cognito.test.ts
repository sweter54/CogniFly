import { describe, expect, it } from 'vitest';
import { confirmEmailCode, refreshTokens, startEmailLogin, type CognitoContext } from '../src/logic/cognito.js';
import { CognitoError, NetworkError } from '../src/logic/errors.js';
import { header, scriptedFetch, type Scripted } from './helpers.js';

const NOW = 1_000_000;
const ctx = (script: Scripted[]) => {
  const f = scriptedFetch(script);
  const c: CognitoContext = { fetch: f.fetch, region: 'eu-central-1', clientId: 'klient1', now: () => NOW };
  return { c, calls: f.calls };
};
const cognitoError = (type: string): Scripted => ({ status: 400, body: { __type: `com.amazonaws#${type}` } });

describe('startEmailLogin', () => {
  it('starts USER_AUTH with EMAIL_OTP and returns the session', async () => {
    const { c, calls } = ctx([{ status: 200, body: { ChallengeName: 'EMAIL_OTP', Session: 'S1' } }]);
    expect(await startEmailLogin(c, ' a@b.pl ')).toEqual({ email: 'a@b.pl', session: 'S1' });
    expect(calls[0]!.url).toBe('https://cognito-idp.eu-central-1.amazonaws.com/');
    expect(header(calls[0]!, 'X-Amz-Target')).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(calls[0]!.body).toEqual({
      AuthFlow: 'USER_AUTH', ClientId: 'klient1',
      AuthParameters: { USERNAME: 'a@b.pl', PREFERRED_CHALLENGE: 'EMAIL_OTP' },
    });
  });

  it('rejects other challenges', async () => {
    const { c } = ctx([{ status: 200, body: { ChallengeName: 'PASSWORD', Session: 'S' } }]);
    await expect(startEmailLogin(c, 'a@b.pl')).rejects.toEqual(new CognitoError('UNEXPECTED_CHALLENGE'));
  });

  it('rejects an address without @ before any request', async () => {
    const { c, calls } = ctx([]);
    await expect(startEmailLogin(c, 'abc')).rejects.toEqual(new CognitoError('BAD_EMAIL'));
    expect(calls).toHaveLength(0);
  });
});

describe('confirmEmailCode', () => {
  const pending = { email: 'a@b.pl', session: 'S1' };

  it('returns tokens with expiry from ExpiresIn', async () => {
    const { c, calls } = ctx([{ status: 200, body: { AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R', ExpiresIn: 600 } } }]);
    expect(await confirmEmailCode(c, pending, ' 12345678 ')).toEqual({ accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 600_000 });
    expect(calls[0]!.body).toMatchObject({ ChallengeName: 'EMAIL_OTP', Session: 'S1', ChallengeResponses: { USERNAME: 'a@b.pl', EMAIL_OTP_CODE: '12345678' } });
  });

  it.each([
    ['CodeMismatchException', 'WRONG_CODE'],
    ['ExpiredCodeException', 'CODE_EXPIRED'],
    ['NotAuthorizedException', 'SESSION_EXPIRED'],
  ])('maps %s to %s and keeps the original as detail', async (type, code) => {
    const { c } = ctx([cognitoError(type)]);
    await expect(confirmEmailCode(c, pending, '123456')).rejects.toMatchObject({ code, detail: type });
  });

  it('rejects non-numeric codes locally', async () => {
    const { c, calls } = ctx([]);
    await expect(confirmEmailCode(c, pending, 'abc')).rejects.toMatchObject({ code: 'WRONG_CODE', detail: 'FORMAT' });
    expect(calls).toHaveLength(0);
  });

  it('ignores spaces and dashes inside a pasted code', async () => {
    const { c, calls } = ctx([{ status: 200, body: { AuthenticationResult: { AccessToken: 'A', RefreshToken: 'R' } } }]);
    await confirmEmailCode(c, pending, ' 1234 5678\n');
    expect(calls[0]!.body).toMatchObject({ ChallengeResponses: { EMAIL_OTP_CODE: '12345678' } });
  });

  it('reports another challenge instead of a wrong code', async () => {
    const { c } = ctx([{ status: 200, body: { ChallengeName: 'SELECT_CHALLENGE', Session: 'S2' } }]);
    await expect(confirmEmailCode(c, pending, '123456')).rejects.toMatchObject({ code: 'UNEXPECTED_CHALLENGE', detail: 'SELECT_CHALLENGE' });
  });
});

describe('refreshTokens', () => {
  it('keeps the old refresh token when Cognito does not rotate it', async () => {
    const { c, calls } = ctx([{ status: 200, body: { AuthenticationResult: { AccessToken: 'A2', ExpiresIn: 3600 } } }]);
    expect(await refreshTokens(c, 'R1')).toEqual({ accessToken: 'A2', refreshToken: 'R1', expiresAt: NOW + 3_600_000 });
    expect(calls[0]!.body).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: 'klient1', AuthParameters: { REFRESH_TOKEN: 'R1' } });
  });

  it('passes through NotAuthorizedException and network errors', async () => {
    await expect(refreshTokens(ctx([cognitoError('NotAuthorizedException')]).c, 'R')).rejects.toEqual(new CognitoError('NotAuthorizedException'));
    await expect(refreshTokens(ctx([new TypeError('x')]).c, 'R')).rejects.toBeInstanceOf(NetworkError);
  });
});
