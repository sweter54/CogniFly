/**
 * Feeds Heartwood's registry from CogniFly's people (decision D6):
 * one org per company, one shared workspace `wspolne`, topics from a flag;
 * members get `write`, company admins get `admin`.
 *
 * DRY RUN BY DEFAULT: without `--wykonaj` it only prints the steps (it
 * reads the company's people from DynamoDB, read-only, and calls neither
 * Cognito nor Heartwood).
 *
 *   --firma <id>             company id (required)
 *   --pula <id>              Cognito user pool id (required)
 *   --int-url <url>          Heartwood API base url (required)
 *   --tematy A,B             topics (default `Dokumenty`)
 *                            `Zadania` is always added
 *   --region <r>             SigV4 region of the API (default eu-central-1)
 *   --wykonaj                really call Cognito, DynamoDB and Heartwood
 *
 * Run: npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot --pula <id> \
 *        --int-url <url> [--tematy Dokumenty,Oferty] [--wykonaj]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

type Right = 'none' | 'read' | 'write' | 'admin';
type Rola = 'admin' | 'czlonek';

/** A person record of the company. */
export interface OsobaRejestru { osoba: string; email: string; rola: Rola; sub?: string }

/** Options of the plan. */
export interface OpcjePlanu { firma: string; tematy: string[] }

const WS = 'wspolne';
const WS_NAZWA = 'Wspólne';
const REGION = 'eu-central-1';
/** Topic that always exists: task folders live under it. */
const TEMAT_ZADAN = 'Zadania';

/** One step of the feeding plan. */
export type Krok =
  | { typ: 'org'; org: string; nazwa: string }
  | { typ: 'szukajSub'; osoba: string; email: string; rola: Rola }
  | { typ: 'osoba'; org: string; osoba: string; sub?: string; isAdmin: boolean }
  | { typ: 'przestrzen'; org: string; ws: string; nazwa: string }
  | { typ: 'temat'; org: string; ws: string; temat: string }
  | { typ: 'prawo'; org: string; ws: string; osoba: string; right: Right };

/** The part of the Heartwood client the script needs. */
export interface Klient {
  putOrg(org: string, name: string): Promise<void>;
  putPerson(org: string, sub: string, isAdmin: boolean): Promise<void>;
  putWorkspace(org: string, ws: string, name: string): Promise<void>;
  putTopic(org: string, ws: string, topic: string): Promise<void>;
  putGrant(org: string, ws: string, sub: string, right: Right): Promise<void>;
}

/** Injected side effects (fakes in tests). */
export interface Zaleznosci {
  client: Klient;
  osoby(firma: string): Promise<OsobaRejestru[]>;
  szukajSub(email: string): Promise<string>;
  zapiszSub(osoba: string, email: string, rola: Rola, sub: string): Promise<void>;
}

/**
 * Plans the registry feed (pure).
 *
 * Call: `planZasilenia(osoby, { firma, tematy })`.
 * Expects: people of the company (`sub` optional), topic names.
 * Output: steps in order: org, per person [lookup, person], workspace,
 *   topics (`Zadania` is always added), grants (`admin` for
 *   admins, `write` otherwise).
 */
export function planZasilenia(osoby: OsobaRejestru[], o: OpcjePlanu): Krok[] {
  const org = o.firma;
  const ludzie = osoby.flatMap((p): Krok[] => [
    ...(p.sub ? [] : [{ typ: 'szukajSub' as const, osoba: p.osoba, email: p.email, rola: p.rola }]),
    { typ: 'osoba', org, osoba: p.osoba, ...(p.sub ? { sub: p.sub } : {}), isAdmin: p.rola === 'admin' },
  ]);
  return [
    { typ: 'org', org, nazwa: org },
    ...ludzie,
    { typ: 'przestrzen', org, ws: WS, nazwa: WS_NAZWA },
    ...[...new Set([...o.tematy, TEMAT_ZADAN])].map((temat): Krok => ({ typ: 'temat', org, ws: WS, temat })),
    ...osoby.map((p): Krok => ({
      typ: 'prawo', org, ws: WS, osoba: p.osoba, right: p.rola === 'admin' ? 'admin' : 'write',
    })),
  ];
}

/**
 * Describes a step for the dry run.
 *
 * Call: `opisz(krok)`.
 * Expects: any step.
 * Output: one Polish line, with no secrets.
 */
export function opisz(k: Krok): string {
  switch (k.typ) {
    case 'org': return `Heartwood: organizacja ${k.org} ("${k.nazwa}")`;
    case 'szukajSub': return `Cognito: sub użytkownika ${k.email} -> zapis do OSOBA#${k.osoba}`;
    case 'osoba': return `Heartwood: osoba ${k.osoba}${k.sub ? '' : ' (sub z Cognito)'}, isAdmin=${k.isAdmin}`;
    case 'przestrzen': return `Heartwood: przestrzeń ${k.ws} ("${k.nazwa}")`;
    case 'temat': return `Heartwood: temat ${k.temat} w ${k.ws}`;
    case 'prawo': return `Heartwood: prawo ${k.right} dla ${k.osoba} w ${k.ws}`;
  }
}

/**
 * Runs the steps against the injected dependencies.
 *
 * Call: `await wykonaj(kroki, deps, log)`.
 * Expects: steps from `planZasilenia` (lookup precedes its person step).
 * Output: resolves when all calls succeeded; throws on the first failure.
 */
export async function wykonaj(
  kroki: Krok[], d: Zaleznosci, log: (s: string) => void = () => {},
): Promise<void> {
  const suby = new Map<string, string>();
  const sub = (osoba: string, jawny?: string) => {
    const s = jawny ?? suby.get(osoba);
    if (!s) throw new Error(`Brak sub dla osoby ${osoba}.`);
    return s;
  };
  for (const k of kroki) {
    if (k.typ === 'org') await d.client.putOrg(k.org, k.nazwa);
    else if (k.typ === 'szukajSub') {
      const s = await d.szukajSub(k.email);
      await d.zapiszSub(k.osoba, k.email, k.rola, s);
      suby.set(k.osoba, s);
    } else if (k.typ === 'osoba') {
      if (k.sub) suby.set(k.osoba, k.sub);
      await d.client.putPerson(k.org, sub(k.osoba, k.sub), k.isAdmin);
    } else if (k.typ === 'przestrzen') await d.client.putWorkspace(k.org, k.ws, k.nazwa);
    else if (k.typ === 'temat') await d.client.putTopic(k.org, k.ws, k.temat);
    else await d.client.putGrant(k.org, k.ws, sub(k.osoba), k.right);
    log(`ok: ${opisz(k)}`);
  }
}

/** Parsed command line. */
export interface Opcje {
  firma: string; pula: string; intUrl: string; tematy: string[]; region: string; wykonaj: boolean;
}

/**
 * Parses the command line.
 *
 * Call: `przeczytajOpcje(process.argv.slice(2), process.env)`.
 * Expects: `--firma`, `--pula` (or `COGNIFLY_PULA`), `--int-url`.
 * Output: the options; throws a Polish error when a required one is missing.
 */
export function przeczytajOpcje(argv: string[], env: NodeJS.ProcessEnv): Opcje {
  const { values } = parseArgs({
    args: argv,
    options: {
      firma: { type: 'string' }, pula: { type: 'string' }, 'int-url': { type: 'string' },
      tematy: { type: 'string' }, region: { type: 'string' },
      wykonaj: { type: 'boolean', default: false },
    },
  });
  const wymagany = (w: string | undefined, flaga: string) => {
    if (!w) throw new Error(`Brak wartości ${flaga}.`);
    return w;
  };
  const tematy = (values.tematy ?? 'Dokumenty').split(',').map((t) => t.trim()).filter(Boolean);
  return {
    firma: wymagany(values.firma, '--firma'),
    pula: wymagany(values.pula ?? env.COGNIFLY_PULA, '--pula'),
    intUrl: wymagany(values['int-url'], '--int-url'),
    tematy: tematy.length > 0 ? tematy : ['Dokumenty'],
    region: values.region ?? REGION,
    wykonaj: values.wykonaj === true,
  };
}

/**
 * Looks up a Cognito user's `sub` by e-mail (read-only, never creates).
 *
 * Call: `await subZCognito(cog, pula, email)`.
 * Expects: an existing user in the pool.
 * Output: the `sub`; throws when the user or attribute is missing.
 */
export async function subZCognito(
  cog: Pick<CognitoIdentityProviderClient, 'send'>, pula: string, email: string,
): Promise<string> {
  const r = await cog.send(new AdminGetUserCommand({ UserPoolId: pula, Username: email }));
  const sub = r.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error(`Cognito nie zwróciło atrybutu sub dla ${email}.`);
  return sub;
}

/**
 * Builds the real dependencies (AWS clients, DynamoDB, Heartwood).
 *
 * Call: `await zaleznosciAws(opcje)`.
 * Expects: AWS credentials in the environment.
 * Output: dependencies bound to the company in `opcje`.
 */
async function zaleznosciAws(o: Opcje): Promise<Zaleznosci> {
  // Dynamic imports: server modules read env (table, region) lazily.
  const dane = await import('../../serwer/src/dane/konfiguracja.js');
  const { intClient } = await import('../../serwer/src/heartwood/klient.js');
  const cog = new CognitoIdentityProviderClient({ region: REGION });
  return {
    client: intClient({ url: o.intUrl, region: o.region }),
    osoby: dane.rejestrOsob,
    szukajSub: (email) => subZCognito(cog, o.pula, email),
    zapiszSub: (osoba, email, rola, sub) => dane.zapiszOsobe(o.firma, osoba, { email, rola, sub }),
  };
}

/**
 * Plans and (with `--wykonaj`) runs the feed.
 *
 * Call: `await zasil(opcje, log, deps?)`.
 * Expects: parsed options; `deps` only in tests.
 * Output: prints the steps; without `wykonaj` nothing is written.
 */
export async function zasil(
  o: Opcje, log: (s: string) => void = console.log, zal?: Zaleznosci,
): Promise<void> {
  log(`Zasilenie rejestru Heartwood, firma "${o.firma}": ${o.wykonaj ? 'WYKONANIE' : 'DRY-RUN (dodaj --wykonaj)'}`);
  const d = zal ?? await zaleznosciAws(o);
  const kroki = planZasilenia(await d.osoby(o.firma), { firma: o.firma, tematy: o.tematy });
  if (!o.wykonaj) {
    for (const k of kroki) log(`- ${opisz(k)}`);
    return;
  }
  await wykonaj(kroki, d, log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  zasil(przeczytajOpcje(process.argv.slice(2), process.env)).catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
