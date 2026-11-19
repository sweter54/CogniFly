/**
 * Feeds Heartwood's registry from CogniFly's people (Platform pool):
 * one shared workspace `wspolne`, topics from a flag; members get
 * `write`, company admins get `admin`; open tasks are re-sent as work
 * state with the new Cognito `sub`. Orgs and people are NOT created here:
 * they arrive from Identity (Tozsamosc) and its events.
 *
 * DRY RUN BY DEFAULT: without `--wykonaj` it only prints the steps (it
 * reads the company's people and open tasks from DynamoDB, read-only,
 * and does not call Heartwood).
 *
 *   --firma <id>             company id (required)
 *   --int-url <url>          Heartwood API base url (required)
 *   --tematy A,B             topics (default `Dokumenty`)
 *                            `Zadania` is always added
 *   --region <r>             SigV4 region of the API (default eu-central-1)
 *   --wykonaj                really call Heartwood (DynamoDB stays read-only)
 *
 * Run: npx tsx infra/skrypty/zasil-heartwood.ts --firma pilot \
 *        --int-url <url> [--tematy Dokumenty,Oferty] [--wykonaj]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Task } from '@cognifly/wspolne/api';
import { workIdOf, workStateOf } from '../../serwer/src/heartwood/praca.js';

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
  | { typ: 'przestrzen'; org: string; ws: string; nazwa: string }
  | { typ: 'temat'; org: string; ws: string; temat: string }
  | { typ: 'prawo'; org: string; ws: string; sub: string; osoba: string; right: Right }
  | { typ: 'pominieta'; osoba: string }
  | { typ: 'praca'; org: string; workId: string; writer: string | null; closed: false };

/** The part of the Heartwood client the script needs. */
export interface Klient {
  putWork(org: string, workId: string, s: { writer: string | null; closed: boolean }): Promise<void>;
  putWorkspace(org: string, ws: string, name: string): Promise<void>;
  putTopic(org: string, ws: string, topic: string): Promise<void>;
  putGrant(org: string, ws: string, sub: string, right: Right): Promise<void>;
}

/** Injected side effects (fakes in tests). */
export interface Zaleznosci {
  client: Klient;
  osoby(firma: string): Promise<OsobaRejestru[]>;
  zadania(firma: string): Promise<Task[]>;
}

/**
 * Plans the registry feed (pure).
 *
 * Call: `planZasilenia(osoby, zadania, { firma, tematy })`.
 * Expects: people of the company (`sub` optional), open tasks, topics.
 * Output: steps in order: workspace, topics (`Zadania` always added),
 *   grants (`admin` for admins, `write` otherwise; people without `sub`
 *   give one `pominieta` step instead), work state of open tasks with
 *   `writer` = the person's `sub` (`null` when missing).
 */
export function planZasilenia(osoby: OsobaRejestru[], zadania: Task[], o: OpcjePlanu): Krok[] {
  const org = o.firma;
  const suby = new Map(osoby.map((p) => [p.osoba, p.sub]));
  const prawa = osoby.map((p): Krok => p.sub
    ? { typ: 'prawo', org, ws: WS, sub: p.sub, osoba: p.osoba, right: p.rola === 'admin' ? 'admin' : 'write' }
    : { typ: 'pominieta', osoba: p.osoba });
  return [
    { typ: 'przestrzen', org, ws: WS, nazwa: WS_NAZWA },
    ...[...new Set([...o.tematy, TEMAT_ZADAN])].map((temat): Krok => ({ typ: 'temat', org, ws: WS, temat })),
    ...prawa,
    ...zadania.flatMap((z): Krok[] => {
      const st = workStateOf(z);
      if (!st || st.closed) return [];
      const writer = (st.writer && suby.get(st.writer)) || null;
      return [{ typ: 'praca', org, workId: workIdOf(z.id), writer, closed: false }];
    }),
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
    case 'przestrzen': return `Heartwood: przestrzeń ${k.ws} ("${k.nazwa}")`;
    case 'temat': return `Heartwood: temat ${k.temat} w ${k.ws}`;
    case 'prawo': return `Heartwood: prawo ${k.right} dla ${k.osoba} w ${k.ws}`;
    case 'pominieta': return `Pominięto ${k.osoba}: brak sub z Tożsamości`;
    case 'praca': return `Heartwood: praca ${k.workId}, pisze ${k.writer ? 'osoba z sub' : 'nikt (brak sub)'}`;
  }
}

/**
 * Runs the steps against the injected dependencies.
 *
 * Call: `await wykonaj(kroki, deps, log)`.
 * Expects: steps from `planZasilenia`.
 * Output: resolves when all calls succeeded; throws on the first failure.
 *   A `pominieta` step only logs.
 */
export async function wykonaj(
  kroki: Krok[], d: Zaleznosci, log: (s: string) => void = () => {},
): Promise<void> {
  for (const k of kroki) {
    if (k.typ === 'przestrzen') await d.client.putWorkspace(k.org, k.ws, k.nazwa);
    else if (k.typ === 'temat') await d.client.putTopic(k.org, k.ws, k.temat);
    else if (k.typ === 'prawo') await d.client.putGrant(k.org, k.ws, k.sub, k.right);
    else if (k.typ === 'praca') await d.client.putWork(k.org, k.workId, { writer: k.writer, closed: k.closed });
    log(k.typ === 'pominieta' ? opisz(k) : `ok: ${opisz(k)}`);
  }
}

/** Parsed command line. */
export interface Opcje {
  firma: string; intUrl: string; tematy: string[]; region: string; wykonaj: boolean;
}

/**
 * Parses the command line.
 *
 * Call: `przeczytajOpcje(process.argv.slice(2), process.env)`.
 * Expects: `--firma`, `--int-url`.
 * Output: the options; throws a Polish error when a required one is missing.
 */
export function przeczytajOpcje(argv: string[], env: NodeJS.ProcessEnv): Opcje {
  const { values } = parseArgs({
    args: argv,
    options: {
      firma: { type: 'string' }, 'int-url': { type: 'string' },
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
    intUrl: wymagany(values['int-url'], '--int-url'),
    tematy: tematy.length > 0 ? tematy : ['Dokumenty'],
    region: values.region ?? REGION,
    wykonaj: values.wykonaj === true,
  };
}

/**
 * Builds the real dependencies (DynamoDB reads, Heartwood).
 *
 * Call: `await zaleznosciAws(opcje)`.
 * Expects: AWS credentials in the environment.
 * Output: dependencies bound to the company in `opcje`.
 */
async function zaleznosciAws(o: Opcje): Promise<Zaleznosci> {
  // Dynamic imports: server modules read env (table, region) lazily.
  const dane = await import('../../serwer/src/dane/konfiguracja.js');
  const { otwarteZadania } = await import('../../serwer/src/dane/kolejka.js');
  const { intClient } = await import('../../serwer/src/heartwood/klient.js');
  return {
    client: intClient({ url: o.intUrl, region: o.region }),
    osoby: dane.rejestrOsob,
    zadania: otwarteZadania,
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
  const kroki = planZasilenia(await d.osoby(o.firma), await d.zadania(o.firma), { firma: o.firma, tematy: o.tematy });
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
