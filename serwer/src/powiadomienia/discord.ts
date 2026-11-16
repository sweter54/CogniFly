import type { Wiadomosc } from './format.js';

export function poprawnyWebhook(adres: string): boolean {
  let u: URL;
  try {
    u = new URL(adres);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' && u.hostname === 'discord.com' && u.port === '' &&
    u.username === '' && u.password === '' && u.pathname.startsWith('/api/webhooks/') && u.pathname.length > '/api/webhooks/'.length
  );
}

export async function wyslijDiscord(
  webhookUrl: string,
  wiad: Pick<Wiadomosc, 'discord'>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<void> {
  if (!poprawnyWebhook(webhookUrl)) throw new Error('niepoprawny adres webhooka Discorda');
  const r = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wiad.discord),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Discord odpowiedział ${r.status}`);
}
