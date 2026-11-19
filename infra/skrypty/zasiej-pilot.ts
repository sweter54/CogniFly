/**
 * Zasiew środowiska pilotażowego (firma `pilot`) — Task 8, krok 7.
 *
 * DOMYŚLNIE DRY-RUN: bez `--wykonaj` skrypt tylko wypisuje plan i nie woła AWS.
 * Z `--wykonaj` woła Secrets Manager i DynamoDB (konto testowe, eu-central-1).
 * Osoby (sub, rola) NIE są tu tworzone: przychodzą z Tożsamości (Tożsamość / Platforma);
 * e-maile i osobaId służą tylko jako klucze kontaktów, Discorda i loginów GitHub.
 *
 * Wartości wrażliwe (adres webhooka Discorda, sekret GitHuba) podawaj ZMIENNYMI ŚRODOWISKOWYMI (ZASIEJ_DISCORD_*,
 * ZASIEJ_SEKRET_GITHUB), nie flagami: flagi lądują w historii powłoki i w liście procesów.
 *
 * Parametry (flaga albo zmienna środowiskowa; adresów i sekretów NIE zapisujemy w repo):
 *   --email-michal / ZASIEJ_EMAIL_MICHAL        (wymagany)  e-mail Michała
 *   --email-szymon / ZASIEJ_EMAIL_SZYMON        (opcjonalny)
 *   --osoba-michal / ZASIEJ_OSOBA_MICHAL        osobaId Michała (domyślnie `michal`)
 *   --osoba-szymon / ZASIEJ_OSOBA_SZYMON        osobaId Szymona (domyślnie `szymon`)
 *   --discord-michal / ZASIEJ_DISCORD_MICHAL    adres webhooka Discorda Michała (opcjonalny)
 *   --github-michal / ZASIEJ_GITHUB_MICHAL      login GitHub Michała (opcjonalny; przekazanie zadań po code review)
 *   --discord-szymon / ZASIEJ_DISCORD_SZYMON    adres webhooka Discorda Szymona (opcjonalny)
 *   --sekret-github / ZASIEJ_SEKRET_GITHUB      sekret webhooka GitHuba (domyślnie: istniejący sekret zostaje, brakujący = losowe 32 bajty hex)
 *   --wykonaj                                   faktycznie wykonaj zapisy
 *
 * Uruchomienie: npx tsx infra/skrypty/zasiej-pilot.ts --email-michal ... [--wykonaj]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, ResourceExistsException, ResourceNotFoundException, SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Regula } from '@cognifly/wspolne';

export const FIRMA = 'pilot';
export const REGION = 'eu-central-1';
export const SEKRET_GITHUB = 'cognifly-test/github/pilot';
export const sekretDiscord = (osoba: string) => `cognifly-test/discord/pilot/${osoba}`;

export interface Osoba { osobaId: string; email: string; discord?: string; github?: string }

export function regulaPilota(osobaMichal: string): Regula {
  return {
    id: 'pilot-github-pr', firma: FIRMA,
    gdy: { zrodlo: 'github', typ: 'github.pr.*' },
    powiadom: { osoby: [osobaMichal], kanaly: ['email', 'discord'] },
    przydziel: { osoby: [osobaMichal] },
    eskalacjaMin: 15,
  };
}

export function przeczytajOpcje(argv: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'email-michal': { type: 'string' }, 'email-szymon': { type: 'string' },
      'osoba-michal': { type: 'string' }, 'osoba-szymon': { type: 'string' },
      'discord-michal': { type: 'string' }, 'discord-szymon': { type: 'string' },
      'github-michal': { type: 'string' }, 'github-szymon': { type: 'string' },
      'sekret-github': { type: 'string' },
      wykonaj: { type: 'boolean', default: false },
    },
  });
  const emailMichal = values['email-michal'] ?? env.ZASIEJ_EMAIL_MICHAL;
  if (!emailMichal) throw new Error('Brak e-maila Michała (--email-michal albo ZASIEJ_EMAIL_MICHAL).');
  const osoby: Osoba[] = [{
    osobaId: values['osoba-michal'] ?? env.ZASIEJ_OSOBA_MICHAL ?? 'michal', email: emailMichal,
    discord: values['discord-michal'] ?? env.ZASIEJ_DISCORD_MICHAL,
    github: values['github-michal'] ?? env.ZASIEJ_GITHUB_MICHAL,
  }];
  const emailSzymon = values['email-szymon'] ?? env.ZASIEJ_EMAIL_SZYMON;
  if (emailSzymon) {
    osoby.push({
      osobaId: values['osoba-szymon'] ?? env.ZASIEJ_OSOBA_SZYMON ?? 'szymon', email: emailSzymon,
      discord: values['discord-szymon'] ?? env.ZASIEJ_DISCORD_SZYMON,
      github: values['github-szymon'] ?? env.ZASIEJ_GITHUB_SZYMON,
    });
  }
  return {
    osoby, wykonaj: values.wykonaj === true,
    sekretGithub: values['sekret-github'] ?? env.ZASIEJ_SEKRET_GITHUB,
  };
}

/**
 * Z wartością: tworzy sekret albo dopisuje nową wersję. Bez wartości (nic nie podano): istniejący sekret zostaje
 * nietknięty (inaczej ponowne uruchomienie zmieniłoby sekret skonfigurowanego webhooka), brakujący jest tworzony
 * losową wartością. Wartości nie loguje.
 */
async function zapiszSekret(
  sm: Pick<SecretsManagerClient, 'send'>, nazwa: string, wartosc: string | undefined,
): Promise<'utworzony' | 'zaktualizowany' | 'zachowany'> {
  if (wartosc === undefined) {
    try {
      await sm.send(new DescribeSecretCommand({ SecretId: nazwa }));
      return 'zachowany';
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
    wartosc = randomBytes(32).toString('hex');
  }
  try {
    await sm.send(new CreateSecretCommand({ Name: nazwa, SecretString: wartosc, Tags: [{ Key: 'Project', Value: 'cognifly' }] }));
    return 'utworzony';
  } catch (e) {
    if (!(e instanceof ResourceExistsException)) throw e;
    await sm.send(new PutSecretValueCommand({ SecretId: nazwa, SecretString: wartosc }));
    return 'zaktualizowany';
  }
}

export interface Dane {
  zapiszKontakt(firma: string, osoba: string, k: { email?: string; discordWebhookRef?: string }): Promise<void>;
  zapiszRegule(r: Regula): Promise<void>;
  kontaktOsoby(firma: string, osoba: string): Promise<{ email?: string; discordWebhookRef?: string }>;
  zapiszLoginGithub(firma: string, login: string, osoba: string): Promise<void>;
}
export interface Zaleznosci {
  sm: Pick<SecretsManagerClient, 'send'>;
  dane: Dane;
}

export async function zasiej(
  opcje: ReturnType<typeof przeczytajOpcje>, log: (s: string) => void = console.log, zal?: Zaleznosci,
): Promise<void> {
  const { osoby, wykonaj } = opcje;
  const michal = osoby[0]!;
  const regula = regulaPilota(michal.osobaId);
  const tryb = wykonaj ? 'WYKONANIE' : 'DRY-RUN (nic nie jest zapisywane; dodaj --wykonaj)';
  log(`Zasiew firmy "${FIRMA}": ${tryb}`);

  if (!wykonaj) {
    log('- Osoby (sub, rola) przychodzą z Tożsamości (Platforma); ten skrypt ich nie tworzy ani nie woła Cognito');
    for (const o of osoby) {
      log(`- DynamoDB: KONTAKT#${o.osobaId}${o.discord ? ` z discordWebhookRef=${sekretDiscord(o.osobaId)}` : ' (tylko e-mail)'}${o.github ? `, GITHUB#${o.github.toLowerCase()}` : ''}`);
      if (o.discord) log(`- Secrets Manager: ${sekretDiscord(o.osobaId)} (adres webhooka Discorda; wartość nie jest wypisywana)`);
    }
    log(`- Secrets Manager: ${SEKRET_GITHUB} (${opcje.sekretGithub ? 'podany sekret' : 'istniejący zostaje, brakujący dostanie losowe 32 bajty hex'}; wartość nie jest wypisywana)`);
    log(`- DynamoDB: reguła ${regula.id}: ${regula.gdy.typ} -> powiadom ${michal.osobaId} [email, discord], przydziel ${michal.osobaId}, eskalacjaMin ${regula.eskalacjaMin}`);
    return;
  }

  if (!zal) {
    // Import dynamiczny: moduły serwera czytają COGNIFLY_TABELA / region z env dopiero przy użyciu.
    const dane = await import('../../serwer/src/dane/konfiguracja.js');
    zal = {
      sm: new SecretsManagerClient({ region: REGION }),
      dane,
    };
  }
  const { sm, dane } = zal;

  for (const o of osoby) {
    // Kontakt scalamy z istniejącym: ponowny przebieg bez --discord-* nie może zgubić discordWebhookRef.
    const istniejacy = await dane.kontaktOsoby(FIRMA, o.osobaId);
    let discordWebhookRef = istniejacy.discordWebhookRef;
    if (o.discord) {
      discordWebhookRef = sekretDiscord(o.osobaId);
      log(`sekret ${discordWebhookRef}: ${await zapiszSekret(sm, discordWebhookRef, o.discord)}`);
    }
    await dane.zapiszKontakt(FIRMA, o.osobaId, { email: o.email, ...(discordWebhookRef ? { discordWebhookRef } : {}) });
    if (o.github) {
      await dane.zapiszLoginGithub(FIRMA, o.github, o.osobaId);
      log(`osoba ${o.osobaId}: login GitHub ${o.github}`);
    }
    log(`osoba ${o.osobaId}: kontakt zapisany`);
  }

  log(`sekret ${SEKRET_GITHUB}: ${await zapiszSekret(sm, SEKRET_GITHUB, opcje.sekretGithub)} (wartość nie jest wypisywana)`);
  await dane.zapiszRegule(regula);
  log(`reguła ${regula.id} zapisana`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  zasiej(przeczytajOpcje(process.argv.slice(2), process.env)).catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
