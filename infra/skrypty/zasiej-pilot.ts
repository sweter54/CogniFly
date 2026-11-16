/**
 * Zasiew środowiska pilotażowego (firma `pilot`) — Task 8, krok 7.
 *
 * DOMYŚLNIE DRY-RUN: bez `--wykonaj` skrypt tylko wypisuje plan i nie woła AWS.
 * Z `--wykonaj` woła Cognito, Secrets Manager i DynamoDB (konto testowe, eu-central-1).
 *
 * Wartości wrażliwe (adres webhooka Discorda, sekret GitHuba) podawaj ZMIENNYMI ŚRODOWISKOWYMI (ZASIEJ_DISCORD_*,
 * ZASIEJ_SEKRET_GITHUB), nie flagami: flagi lądują w historii powłoki i w liście procesów.
 *
 * Parametry (flaga albo zmienna środowiskowa; adresów i sekretów NIE zapisujemy w repo):
 *   --email-michal / ZASIEJ_EMAIL_MICHAL        (wymagany)  e-mail Michała
 *   --email-szymon / ZASIEJ_EMAIL_SZYMON        (opcjonalny)
 *   --osoba-michal / ZASIEJ_OSOBA_MICHAL        osobaId Michała (domyślnie `michal`)
 *   --osoba-szymon / ZASIEJ_OSOBA_SZYMON        osobaId Szymona (domyślnie `szymon`)
 *   --pula / COGNIFLY_PULA                      id puli Cognito (wyjście stosu PulaCognito)
 *   --discord-michal / ZASIEJ_DISCORD_MICHAL    adres webhooka Discorda Michała (opcjonalny)
 *   --github-michal / ZASIEJ_GITHUB_MICHAL      login GitHub Michała (opcjonalny; przekazanie zadań po code review)
 *   --discord-szymon / ZASIEJ_DISCORD_SZYMON    adres webhooka Discorda Szymona (opcjonalny)
 *   --sekret-github / ZASIEJ_SEKRET_GITHUB      sekret webhooka GitHuba (domyślnie: istniejący sekret zostaje, brakujący = losowe 32 bajty hex)
 *   --wykonaj                                   faktycznie wykonaj zapisy
 *
 * Uruchomienie: npx tsx infra/skrypty/zasiej-pilot.ts --email-michal ... --pula ... [--wykonaj]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient, UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
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
      pula: { type: 'string' },
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
    pula: values.pula ?? env.COGNIFLY_PULA,
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

async function subUzytkownika(cog: Pick<CognitoIdentityProviderClient, 'send'>, pula: string, email: string): Promise<string> {
  const odczytaj = async () => {
    const r = await cog.send(new AdminGetUserCommand({ UserPoolId: pula, Username: email }));
    const sub = r.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error('Cognito nie zwróciło atrybutu sub.');
    return sub;
  };
  try {
    return await odczytaj(); // idempotencja: istniejący użytkownik jest używany ponownie
  } catch (e) {
    if (!(e instanceof UserNotFoundException)) throw e;
  }
  await cog.send(new AdminCreateUserCommand({
    UserPoolId: pula, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  return odczytaj();
}

export interface Dane {
  zapiszTozsamosc(sub: string, firma: string, osobaId: string): Promise<void>;
  zapiszOsobe(firma: string, osoba: string, o: { email: string; rola: 'admin' | 'czlonek' }): Promise<void>;
  zapiszKontakt(firma: string, osoba: string, k: { email?: string; discordWebhookRef?: string }): Promise<void>;
  zapiszRegule(r: Regula): Promise<void>;
  kontaktOsoby(firma: string, osoba: string): Promise<{ email?: string; discordWebhookRef?: string }>;
  zapiszLoginGithub(firma: string, login: string, osoba: string): Promise<void>;
}
export interface Zaleznosci {
  cog: Pick<CognitoIdentityProviderClient, 'send'>;
  sm: Pick<SecretsManagerClient, 'send'>;
  dane: Dane;
}

export async function zasiej(
  opcje: ReturnType<typeof przeczytajOpcje>, log: (s: string) => void = console.log, zal?: Zaleznosci,
): Promise<void> {
  const { osoby, wykonaj, pula } = opcje;
  const michal = osoby[0]!;
  const regula = regulaPilota(michal.osobaId);
  const tryb = wykonaj ? 'WYKONANIE' : 'DRY-RUN (nic nie jest zapisywane; dodaj --wykonaj)';
  log(`Zasiew firmy "${FIRMA}": ${tryb}`);

  if (!wykonaj) {
    for (const o of osoby) {
      log(`- Cognito: użytkownik ${o.email} (email_verified, bez hasła, bez wiadomości) -> sub -> tożsamość ${FIRMA}/${o.osobaId}`);
      log(`- DynamoDB: OSOBA#${o.osobaId} (${o === michal ? 'admin' : 'czlonek'}), KONTAKT#${o.osobaId}${o.discord ? ` z discordWebhookRef=${sekretDiscord(o.osobaId)}` : ' (tylko e-mail)'}${o.github ? `, GITHUB#${o.github.toLowerCase()}` : ''}`);
      if (o.discord) log(`- Secrets Manager: ${sekretDiscord(o.osobaId)} (adres webhooka Discorda; wartość nie jest wypisywana)`);
    }
    log(`- Secrets Manager: ${SEKRET_GITHUB} (${opcje.sekretGithub ? 'podany sekret' : 'istniejący zostaje, brakujący dostanie losowe 32 bajty hex'}; wartość nie jest wypisywana)`);
    log(`- DynamoDB: reguła ${regula.id}: ${regula.gdy.typ} -> powiadom ${michal.osobaId} [email, discord], przydziel ${michal.osobaId}, eskalacjaMin ${regula.eskalacjaMin}`);
    return;
  }

  if (!pula) throw new Error('Brak id puli Cognito (--pula albo COGNIFLY_PULA; wyjście stosu PulaCognito).');
  if (!zal) {
    // Import dynamiczny: moduły serwera czytają COGNIFLY_TABELA / region z env dopiero przy użyciu.
    const dane = await import('../../serwer/src/dane/konfiguracja.js');
    zal = {
      cog: new CognitoIdentityProviderClient({ region: REGION }),
      sm: new SecretsManagerClient({ region: REGION }),
      dane,
    };
  }
  const { cog, sm, dane } = zal;

  for (const o of osoby) {
    const sub = await subUzytkownika(cog, pula, o.email);
    await dane.zapiszTozsamosc(sub, FIRMA, o.osobaId);
    await dane.zapiszOsobe(FIRMA, o.osobaId, { email: o.email, rola: o === michal ? 'admin' : 'czlonek' });
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
    log(`osoba ${o.osobaId}: użytkownik Cognito, tożsamość, osoba i kontakt zapisane`);
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
