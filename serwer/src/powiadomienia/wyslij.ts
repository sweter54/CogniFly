import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Kanal } from '@cognifly/wspolne';
import { kontaktOsoby } from '../dane/konfiguracja.js';
import { wyslijDiscord } from './discord.js';
import { wyslijEmail } from './email.js';
import { formatuj, type DoFormatu } from './format.js';

let sm: SecretsManagerClient | undefined;
const cacheWebhookow = new Map<string, string>();

/** `discordWebhookRef` to id sekretu w Secrets Manager; jego SecretString to adres webhooka. */
async function adresWebhooka(ref: string): Promise<string> {
  const z = cacheWebhookow.get(ref);
  if (z) return z;
  sm ??= new SecretsManagerClient({});
  const r = await sm.send(new GetSecretValueCommand({ SecretId: ref }));
  const url = r.SecretString?.trim();
  if (!url) throw new Error('sekret webhooka jest pusty');
  cacheWebhookow.set(ref, url);
  return url;
}

export async function wyslijPowiadomienia(
  firma: string,
  z: DoFormatu,
  odbiorcy: { osoba: string; kanaly: Kanal[] }[],
  rodzaj: 'nowe' | 'eskalacja',
): Promise<{ wyslane: number; bledy: string[] }> {
  const wiad = formatuj(z, rodzaj);
  let wyslane = 0;
  const bledy: string[] = [];

  for (const { osoba, kanaly } of odbiorcy) {
    // `claude` pomijany: skrzynka = kolejka zadań
    const potrzebne = [...new Set(kanaly)].filter((k) => k === 'email' || k === 'discord');
    if (potrzebne.length === 0) continue;
    let kontakt: Awaited<ReturnType<typeof kontaktOsoby>>;
    try {
      kontakt = await kontaktOsoby(firma, osoba);
    } catch (e) {
      for (const k of potrzebne) bledy.push(`${osoba}/${k}: nie wczytano kontaktu: ${String(e)}`);
      continue;
    }
    for (const k of potrzebne) {
      try {
        if (k === 'email') {
          if (!kontakt.email) throw new Error('brak adresu e-mail');
          await wyslijEmail(kontakt.email, wiad);
        } else {
          if (!kontakt.discordWebhookRef) throw new Error('brak webhooka Discorda');
          await wyslijDiscord(await adresWebhooka(kontakt.discordWebhookRef), wiad);
        }
        wyslane++;
      } catch (e) {
        bledy.push(`${osoba}/${k}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { wyslane, bledy };
}
