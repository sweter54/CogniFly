import { describe, expect, test, vi } from 'vitest';
import { wyslijDiscord } from '../../src/powiadomienia/discord.js';

const OK = 'https://discord.com/api/webhooks/123/abc_DEF-ghi';
const wiad = { temat: 't', tekst: 'x', discord: { content: 'x', allowed_mentions: { parse: [] } } };

describe('wyslijDiscord', () => {
  test('POST JSON na poprawny adres, z timeoutem', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await wyslijDiscord(OK, wiad, f);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(OK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(wiad.discord);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    'http://discord.com/api/webhooks/1/a',
    'https://evil.example/api/webhooks/1/a',
    'https://discord.com.evil.example/api/webhooks/1/a',
    'https://discord.com@evil.example/api/webhooks/1/a',
    'https://discord.com/other/1/a',
    'https://discord.com:8443/api/webhooks/1/a',
  ])('odrzuca %s bez wywołania fetch', async (u) => {
    const f = vi.fn();
    await expect(wyslijDiscord(u, wiad, f)).rejects.toThrow(/adres/i);
    expect(f).not.toHaveBeenCalled();
  });

  test('status błędu -> wyjątek', async () => {
    const f = vi.fn().mockResolvedValue(new Response('no', { status: 404 }));
    await expect(wyslijDiscord(OK, wiad, f)).rejects.toThrow(/404/);
  });
});
