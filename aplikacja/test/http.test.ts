import { describe, expect, it } from 'vitest';
import { NetworkError } from '../src/logic/errors.js';
import { requestJson, stringField } from '../src/logic/http.js';
import { scriptedFetch } from './helpers.js';

describe('requestJson', () => {
  it('sends JSON body with content type and parses the answer', async () => {
    const f = scriptedFetch([{ status: 200, body: { a: 1 } }]);
    const r = await requestJson(f.fetch, 'https://x/y', { method: 'POST', body: { b: 2 } });
    expect(r).toEqual({ status: 200, json: { a: 1 } });
    expect(f.calls[0]!.body).toEqual({ b: 2 });
    expect((f.calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('turns a thrown fetch (offline, timeout) into NetworkError', async () => {
    const f = scriptedFetch([new TypeError('failed')]);
    await expect(requestJson(f.fetch, 'https://x', { method: 'GET' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('treats a non-JSON 2xx page (captive portal) as NetworkError', async () => {
    const f = scriptedFetch([{ status: 200, raw: '<html>' }]);
    await expect(requestJson(f.fetch, 'https://x', { method: 'GET' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns {} for a non-JSON error body', async () => {
    const f = scriptedFetch([{ status: 502, raw: 'Bad gateway' }]);
    expect(await requestJson(f.fetch, 'https://x', { method: 'GET' })).toEqual({ status: 502, json: {} });
  });
});

describe('stringField', () => {
  it('reads only string fields', () => {
    expect(stringField({ a: 'x', b: 1 }, 'a')).toBe('x');
    expect(stringField({ b: 1 }, 'b')).toBeUndefined();
    expect(stringField(null, 'a')).toBeUndefined();
  });
});
