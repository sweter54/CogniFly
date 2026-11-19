// Tools of the `cognifly-zadania` MCP server: plain functions, no
// transport. Read-only; session and API calls reuse the CLI modules.
import { Stan } from '../cli/lib/sesja.mjs';
import { ID_ZADANIA, kontekst, zSesja } from '../cli/lib/api.mjs';

/** Most tasks whose files one tool call reads. */
export const LIMIT_ZADAN = 30;

/** Time budget of one tool call (all its API calls). */
const CZAS_NARZEDZIA = 20_000;

/** States in which the task owner works on the files. */
const STANY_WLASCICIELA = ['wziete', 'w_trakcie'];

/** Polish messages for the error states a tool can end with. */
const KOMUNIKATY = {
  WYMAGA_LOGOWANIA: 'Zaloguj się: cognifly zaloguj',
  BRAK_KONFIGURACJI: 'Brak konfiguracji CogniFly. Skonfiguruj wtyczkę: cognifly konfiguruj',
  ODMOWA: 'Odmowa: pliki sesji w ~/.cognifly nie są zwykłymi plikami.',
  BLAD_SIECI: 'Brak połączenia z CogniFly. Spróbuj ponownie.',
  BRAK_DOSTEPU: 'Brak dostępu do tego zadania.',
  NIE_ZNALEZIONO: 'Nie ma takiego zadania.',
  PLIKI_WYLACZONE: 'Pliki zadań są wyłączone: CogniFly nie jest połączony z Heartwood.',
  ZLE_ZADANIE: 'Nieprawidłowy identyfikator zadania (oczekiwano zad_ i 12 lub 24 cyfr szesnastkowych).',
  ZLA_PRZESTRZEN: 'Nieprawidłowa przestrzeń (np. ws:wspolne lub user:<sub>).',
  ZLA_SCIEZKA: 'Nieprawidłowa ścieżka pliku (względna w przestrzeni, bez „..”).',
};

/**
 * Turns an error into a tool result with `isError`.
 *
 * Call: `wynikBledu(e)` in a tool's catch.
 * Expects: any thrown value; `Stan` carries the state.
 * Output: an MCP tool result with one Polish text.
 */
function wynikBledu(e) {
  const stan = e instanceof Stan ? e.stan : 'NIEOCZEKIWANY';
  const kod = e instanceof Stan && e.dane?.kod ? e.dane.kod : stan;
  const tekst = KOMUNIKATY[stan] ?? `Błąd CogniFly (kod: ${kod}).`;
  return { content: [{ type: 'text', text: tekst }], isError: true };
}

/**
 * Maps a non-200 API answer to a thrown `Stan`.
 *
 * Call: `odmowa(r)` after `zSesja`.
 * Expects: `{status, json}` of a failed call.
 * Throws: always; known codes keep their name, others `BLAD`.
 */
function odmowa(r) {
  const kod = typeof r.json?.kod === 'string' ? r.json.kod : `HTTP_${r.status}`;
  if (r.status === 403) throw new Stan('BRAK_DOSTEPU');
  if (r.status === 404) throw new Stan('NIE_ZNALEZIONO');
  if (r.status === 503 && kod === 'PLIKI_WYLACZONE') throw new Stan('PLIKI_WYLACZONE');
  throw new Stan('BLAD', { kod });
}

/**
 * Validates a task id argument.
 *
 * Call: `idZadania(args.zadanie)`.
 * Expects: any value.
 * Output: the id when it matches the API's task id pattern.
 * Throws: `Stan('ZLE_ZADANIE')`.
 */
function idZadania(v) {
  if (typeof v !== 'string' || !ID_ZADANIA.test(v)) throw new Stan('ZLE_ZADANIE');
  return v;
}

/**
 * Validates and normalizes a file argument.
 *
 * Call: `plikZArgumentow(args)`.
 * Expects: `{przestrzen, sciezka}` strings; the path relative to
 * the space (leading `./` or `/` and trailing `/` are dropped).
 * Output: `{przestrzen, sciezka}` normalized.
 * Throws: `Stan('ZLA_PRZESTRZEN')`, `Stan('ZLA_SCIEZKA')`.
 */
function plikZArgumentow({ przestrzen, sciezka } = {}) {
  const sterujace = /[\p{Cc}\p{Zl}\p{Zp}]/u;
  if (typeof przestrzen !== 'string' || !przestrzen || przestrzen.length > 200 || sterujace.test(przestrzen)) {
    throw new Stan('ZLA_PRZESTRZEN');
  }
  const s = typeof sciezka === 'string' ? sciezka.replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '') : '';
  if (!s || s.length > 1024 || sterujace.test(s) || s.split('/').some((x) => x === '..' || x === '')) {
    throw new Stan('ZLA_SCIEZKA');
  }
  return { przestrzen, sciezka: s };
}

/**
 * Tells whether a task lets the user lock and attach files, like
 * `canLockFiles` in the app (without the local daemon state).
 *
 * Call: `mogeBlokowac(zadanie, ja)`.
 * Expects: a task from the inbox and the person id (null: unknown).
 * Output: true for the owner of a taken / in-progress task and the
 * acceptor of a task waiting for acceptance.
 */
function mogeBlokowac(z, ja) {
  if (ja === null) return false;
  if (z.stan === 'do_akceptacji') return z.akceptujacy === ja;
  return STANY_WLASCICIELA.includes(z.stan) && z.wlasciciel === ja;
}

/**
 * Finds the user's person id in the selected company.
 *
 * Call: `await ktoJa(ctx)`.
 * Expects: a context from `kontekst()`.
 * Output: the person id from `GET /ja` for the default company (or
 * the only one); null when it cannot be told.
 * Throws: session errors (`WYMAGA_LOGOWANIA`, ...).
 */
async function ktoJa(ctx) {
  const r = await zSesja(ctx, 'GET', '/ja');
  const firmy = r.status === 200 && Array.isArray(r.json?.firmy) ? r.json.firmy : [];
  const domyslna = ctx.konf.firmaDomyslna;
  const wpis = domyslna ? firmy.find((f) => f?.firma === domyslna) : firmy.length === 1 ? firmy[0] : null;
  return typeof wpis?.osoba === 'string' ? wpis.osoba : null;
}

/**
 * Tool `moje_zadania`: the user's inbox tasks.
 *
 * Call: `await mojeZadania(ctx)`.
 * Expects: a context from `kontekst()`.
 * Output: `{zadania: [{id, opis, stan, wlasciciel, akceptujacy,
 * moge_blokowac}]}` (missing people as null), tasks the user can
 * lock first.
 * Throws: `Stan` on session or API errors.
 */
async function mojeZadania(ctx) {
  const ja = await ktoJa(ctx);
  const r = await zSesja(ctx, 'GET', '/skrzynka');
  if (r.status !== 200) odmowa(r);
  const lista = Array.isArray(r.json?.zadania) ? r.json.zadania : [];
  const zadania = lista.map((z) => ({
    id: z.id, opis: z.opis ?? '', stan: z.stan, wlasciciel: z.wlasciciel ?? null,
    akceptujacy: z.akceptujacy ?? null, moge_blokowac: mogeBlokowac(z, ja),
  }));
  // Stable sort: lockable tasks first, so the cut keeps them.
  zadania.sort((a, b) => Number(b.moge_blokowac) - Number(a.moge_blokowac));
  return { zadania };
}

/**
 * Tool `pliki_zadania`: locks and changes of one task.
 *
 * Call: `await plikiZadania(ctx, id)`.
 * Expects: a validated task id.
 * Output: the body of `GET /zadania/{id}/pliki`.
 * Throws: `Stan` (`BRAK_DOSTEPU`, `NIE_ZNALEZIONO`, `PLIKI_WYLACZONE`).
 */
async function plikiZadania(ctx, id) {
  const r = await zSesja(ctx, 'GET', `/zadania/${id}/pliki`);
  if (r.status !== 200) odmowa(r);
  return r.json;
}

/**
 * Reads the files of the user's tasks (at most `LIMIT_ZADAN`).
 *
 * Call: `await plikiMoichZadan(ctx)`.
 * Expects: a context; `/ja` runs first, so a stale token is
 * refreshed once before the parallel calls.
 * Output: `{wpisy: [{zadanie, pliki}], pominiete}`; tasks without
 * access (403/404) are skipped.
 * Throws: `Stan` on session errors or `PLIKI_WYLACZONE`.
 */
async function plikiMoichZadan(ctx) {
  const { zadania } = await mojeZadania(ctx);
  const wybrane = zadania.slice(0, LIMIT_ZADAN);
  const wpisy = await Promise.all(wybrane.map(async (zadanie) => {
    try {
      return { zadanie, pliki: await plikiZadania(ctx, zadanie.id) };
    } catch (e) {
      if (e instanceof Stan && ['BRAK_DOSTEPU', 'NIE_ZNALEZIONO'].includes(e.stan)) return null;
      throw e;
    }
  }));
  return { wpisy: wpisy.filter(Boolean), pominiete: zadania.length - wybrane.length };
}

/**
 * Tells whether a path is the given one or lies under it.
 *
 * Call: `podSciezka('a/b.txt', 'a')`.
 * Expects: normalized paths of one space.
 * Output: true for the same path or a path inside that folder.
 */
function podSciezka(sciezka, folder) {
  const f = String(folder ?? '').replace(/^\/+|\/+$/g, '');
  return sciezka === f || (f !== '' && sciezka.startsWith(`${f}/`));
}

/**
 * Tells whether a task lock covers a file.
 *
 * Call: `obejmuje(blokada, plik)`.
 * Expects: a lock of `GET /zadania/{id}/pliki` and a normalized file.
 * Output: true for a lock of the file or of a folder holding it.
 */
function obejmuje(blokada, plik) {
  if (blokada?.przestrzen !== plik.przestrzen) return false;
  const s = String(blokada.sciezka ?? '').replace(/^\/+|\/+$/g, '');
  return blokada.folder === true ? podSciezka(plik.sciezka, s) : s === plik.sciezka;
}

/** Short task reference returned by the file tools. */
const skrot = (z) => ({ id: z.id, opis: z.opis, stan: z.stan });

/**
 * Tool `zadania_dla_pliku`: the user's tasks related to a file.
 *
 * Call: `await zadaniaDlaPliku(ctx, plik)`.
 * Expects: a normalized `{przestrzen, sciezka}`.
 * Output: `{blokujace, zmieniajace, moge_dolaczyc}`; attaching is
 * offered only while none of the tasks locks the file; `pominiete`
 * when more than `LIMIT_ZADAN` tasks were left out.
 * Throws: `Stan` on session errors or `PLIKI_WYLACZONE`.
 */
async function zadaniaDlaPliku(ctx, plik) {
  const { wpisy, pominiete } = await plikiMoichZadan(ctx);
  const lista = (p) => wpisy.filter(p).map((w) => skrot(w.zadanie));
  const blokujace = lista((w) => (w.pliki?.blokady ?? []).some((b) => obejmuje(b, plik)));
  const zmieniajace = lista((w) => (w.pliki?.zmiany ?? [])
    .some((z) => z?.przestrzen === plik.przestrzen && podSciezka(String(z.sciezka ?? '').replace(/^\/+/, ''), plik.sciezka)));
  const moge_dolaczyc = blokujace.length ? [] : lista((w) => w.zadanie.moge_blokowac);
  return { blokujace, zmieniajace, moge_dolaczyc, ...(pominiete ? { pominiete } : {}) };
}

/**
 * Tool `blokada_pliku`: whether one of the user's tasks locks a file.
 *
 * Call: `await blokadaPliku(ctx, plik)`.
 * Expects: a normalized `{przestrzen, sciezka}`.
 * Output: `{stan: 'zablokowany', zadanie, opis, pisze}` or, as locks
 * of other tasks are not visible, `{stan: 'nieznane', powod}`.
 * Throws: `Stan` on session errors or `PLIKI_WYLACZONE`.
 */
async function blokadaPliku(ctx, plik) {
  const { wpisy, pominiete } = await plikiMoichZadan(ctx);
  const w = wpisy.find((x) => (x.pliki?.blokady ?? []).some((b) => obejmuje(b, plik)));
  if (w) return { stan: 'zablokowany', zadanie: w.zadanie.id, opis: w.zadanie.opis, pisze: w.pliki.pisze ?? null };
  const powod = 'Żadne z Twoich zadań nie blokuje tego pliku; blokad innych zadań connector nie widzi.';
  return { stan: 'nieznane', powod, ...(pominiete ? { pominiete } : {}) };
}

/**
 * Tool definitions: name, Polish description, argument names, the
 * argument check (runs before any I/O) and the handler.
 */
export const NARZEDZIA = [
  {
    nazwa: 'moje_zadania',
    opis: 'Zadania z mojej skrzynki CogniFly: id, opis, stan, właściciel, akceptujący i czy mogę blokować ich pliki.',
    argumenty: [],
    sprawdz: () => ({}),
    tylkoOdczyt: true,
    wykonaj: (ctx) => mojeZadania(ctx),
  },
  {
    nazwa: 'pliki_zadania',
    opis: 'Pliki zadania z Heartwood: blokady, zmiany, kto pisze i czy praca jest zamknięta.',
    argumenty: ['zadanie'],
    sprawdz: (a) => ({ zadanie: idZadania(a.zadanie) }),
    tylkoOdczyt: true,
    wykonaj: (ctx, a) => plikiZadania(ctx, a.zadanie),
  },
  {
    nazwa: 'zadania_dla_pliku',
    opis: 'Moje zadania związane z plikiem: które go blokują, które go zmieniały i do których mogę go dołączyć (do 30 zadań).',
    argumenty: ['przestrzen', 'sciezka'],
    sprawdz: plikZArgumentow,
    tylkoOdczyt: true,
    wykonaj: zadaniaDlaPliku,
  },
  {
    nazwa: 'blokada_pliku',
    opis: 'Czy plik jest zablokowany przez jedno z moich zadań i kto w nim pisze; poza moimi zadaniami stan „nieznane”.',
    argumenty: ['przestrzen', 'sciezka'],
    sprawdz: plikZArgumentow,
    tylkoOdczyt: true,
    wykonaj: blokadaPliku,
  },
];

/** Polish descriptions of tool arguments (shared by all tools). */
export const OPISY_ARGUMENTOW = {
  zadanie: 'Identyfikator zadania, np. zad_0123456789ab.',
  przestrzen: 'Przestrzeń Heartwood, np. ws:wspolne lub user:<sub>.',
  sciezka: 'Ścieżka pliku względna w przestrzeni, np. Zadania/raport.docx.',
};

/**
 * Runs one tool and wraps the answer for MCP.
 *
 * Call: `await wywolaj('moje_zadania', {}, process.env)`.
 * Expects: a tool name, its arguments and the environment.
 * Output: `{content: [{type: 'text', text: JSON}]}`, or `isError`
 * with a Polish message (never throws).
 */
export async function wywolaj(nazwa, args, env = process.env) {
  const n = NARZEDZIA.find((x) => x.nazwa === nazwa);
  if (!n) return { content: [{ type: 'text', text: `Nieznane narzędzie: ${nazwa}` }], isError: true };
  try {
    const a = n.sprawdz(args && typeof args === 'object' ? args : {});
    const ctx = kontekst(env, {}, AbortSignal.timeout(CZAS_NARZEDZIA));
    const wynik = await n.wykonaj(ctx, a);
    return { content: [{ type: 'text', text: JSON.stringify(wynik, null, 2) }] };
  } catch (e) {
    return wynikBledu(e);
  }
}
