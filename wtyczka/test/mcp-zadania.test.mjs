import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TASK_ID_PATTERN } from '../../wspolne/src/api.ts';
import { wywolaj, NARZEDZIA } from '../mcp/narzedzia.mjs';
import { utworzSerwer } from '../mcp/zadania.mjs';
import { ID_ZADANIA } from '../cli/lib/api.mjs';

const WTYCZKA = join(dirname(fileURLToPath(import.meta.url)), '..');
const Z1 = 'zad_aaaaaaaaaaaa', Z2 = 'zad_bbbbbbbbbbbb', Z3 = 'zad_cccccccccccc';

/**
 * Starts a fake HTTP API answering with `handler(request)`.
 *
 * Call: `await serwer((r) => ({ status, body }))`.
 * Output: `{ s, log, url }`; `log` collects every request.
 */
function serwer(handler) {
  const log = [];
  const s = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const wpis = { method: req.method, url: req.url, headers: req.headers, body: b ? JSON.parse(b) : undefined };
      log.push(wpis);
      const r = handler(wpis) ?? { status: 404, body: {} };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ s, log, url: `http://127.0.0.1:${s.address().port}` })));
}

let tmp, kat, konf, api, cog, env, trasy;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cog-mcp-'));
  kat = join(tmp, 'kat');
  konf = join(tmp, 'konf.json');
  writeFileSync(konf, JSON.stringify({ adresApi: 'http://x', region: 'eu-central-1', klientCognito: 'KLIENT1', firmaDomyslna: 'firma1' }));
  trasy = {};
  api = await serwer((r) => trasy[r.url]?.(r));
  cog = await serwer(() => ({ status: 400, body: { __type: 'NotAuthorizedException' } }));
  env = { COGNIFLY_KATALOG: kat, COGNIFLY_KONFIGURACJA: konf, COGNIFLY_ADRES_API: api.url, COGNIFLY_COGNITO_ENDPOINT: cog.url };
});
afterEach(() => { api.s.close(); cog.s.close(); rmSync(tmp, { recursive: true, force: true }); });

/** Writes a valid session (expires in an hour). */
function zalogowany() {
  mkdirSync(kat, { recursive: true, mode: 0o700 });
  writeFileSync(join(kat, 'sesja.json'), JSON.stringify({ accessToken: 'A', refreshToken: 'R', wygasa: Date.now() + 3_600_000 }), { mode: 0o600 });
}

const tekst = (w) => w.content.map((c) => c.text).join('\n');
const dane = (w) => JSON.parse(tekst(w));

/** Fake inbox with three tasks: Z1 owned by me, Z2 to accept by me, Z3 new. */
function skrzynka(zadania) {
  trasy['/ja'] = () => ({ status: 200, body: { firmy: [{ firma: 'firma0', osoba: 'obca' }, { firma: 'firma1', osoba: 'ja' }] } });
  trasy['/skrzynka'] = () => ({ status: 200, body: { zadania: zadania ?? [
    { id: Z1, opis: 'Raport', stan: 'w_trakcie', wlasciciel: 'ja', kandydaci: ['ja'], firma: 'firma1' },
    { id: Z2, opis: 'Umowa', stan: 'do_akceptacji', wlasciciel: 'ola', akceptujacy: 'ja', kandydaci: ['ola'], firma: 'firma1' },
    { id: Z3, opis: 'Nowe', stan: 'nowe', kandydaci: ['ja', 'ola'], firma: 'firma1' },
  ] } });
}

/** Fake `GET /zadania/{id}/pliki` answer. */
function pliki(id, { blokady = [], zmiany = [], pisze = null } = {}) {
  trasy[`/zadania/${id}/pliki`] = () => ({ status: 200, body: { zadanie: id, pisze, zamkniete: false, blokady, zmiany } });
}

describe('lista narzędzi', () => {
  it('cztery narzędzia tylko do odczytu, opisy po polsku', () => {
    expect(NARZEDZIA.map((n) => n.nazwa)).toEqual(['moje_zadania', 'pliki_zadania', 'zadania_dla_pliku', 'blokada_pliku']);
    for (const n of NARZEDZIA) {
      expect(n.opis).toMatch(/[ąćęłńóśźż]|zadani/i);
      expect(n.tylkoOdczyt).toBe(true);
    }
  });

  it('identyfikator zadania jak TASK_ID_PATTERN', () => {
    for (const id of [Z1, 'zad_' + 'a'.repeat(24), 'zad_AAAAAAAAAAAA', 'zad_aaa', 'zad_' + 'a'.repeat(13), '', 'x']) {
      expect(ID_ZADANIA.test(id)).toBe(TASK_ID_PATTERN.test(id));
    }
  });
});

describe('brak sesji (Review Focus 3)', () => {
  it.each([
    ['moje_zadania', {}],
    ['pliki_zadania', { zadanie: Z1 }],
    ['zadania_dla_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }],
    ['blokada_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }],
  ])('%s: isError z „Zaloguj się: cognifly zaloguj”, bez wywołania API', async (nazwa, args) => {
    const w = await wywolaj(nazwa, args, env);
    expect(w.isError).toBe(true);
    expect(tekst(w)).toBe('Zaloguj się: cognifly zaloguj');
    expect(api.log).toHaveLength(0);
  });

  it('pusty katalog sesji i odrzucone odświeżenie też kończą się prośbą o logowanie', async () => {
    mkdirSync(kat, { recursive: true, mode: 0o700 });
    writeFileSync(join(kat, 'sesja.json'), JSON.stringify({ accessToken: 'A', refreshToken: 'R', wygasa: 0 }), { mode: 0o600 });
    const w = await wywolaj('moje_zadania', {}, env);
    expect(w.isError).toBe(true);
    expect(tekst(w)).toBe('Zaloguj się: cognifly zaloguj');
  });

  it('brak konfiguracji: czytelny błąd', async () => {
    writeFileSync(konf, JSON.stringify({}));
    const w = await wywolaj('moje_zadania', {}, { ...env, COGNIFLY_ADRES_API: '' });
    expect(w.isError).toBe(true);
    expect(tekst(w)).toMatch(/cognifly konfiguruj/);
  });
});

describe('moje_zadania', () => {
  it('zadania ze skrzynki z moge_blokowac (właściciel w trakcie, akceptujący)', async () => {
    zalogowany();
    skrzynka();
    const w = await wywolaj('moje_zadania', {}, env);
    expect(w.isError).toBeFalsy();
    expect(dane(w)).toEqual({ zadania: [
      { id: Z1, opis: 'Raport', stan: 'w_trakcie', wlasciciel: 'ja', akceptujacy: null, moge_blokowac: true },
      { id: Z2, opis: 'Umowa', stan: 'do_akceptacji', wlasciciel: 'ola', akceptujacy: 'ja', moge_blokowac: true },
      { id: Z3, opis: 'Nowe', stan: 'nowe', wlasciciel: null, akceptujacy: null, moge_blokowac: false },
    ] });
    expect(api.log.find((r) => r.url === '/skrzynka').headers.authorization).toBe('Bearer A');
    expect(api.log.find((r) => r.url === '/skrzynka').headers['x-cognifly-firma']).toBe('firma1');
  });

  it('nieznana osoba (brak /ja): nikt nie może blokować', async () => {
    zalogowany();
    skrzynka();
    trasy['/ja'] = () => ({ status: 500, body: {} });
    const w = await wywolaj('moje_zadania', {}, env);
    expect(dane(w).zadania.map((z) => z.moge_blokowac)).toEqual([false, false, false]);
  });
});

describe('pliki_zadania', () => {
  it('zwraca wynik GET /zadania/{id}/pliki', async () => {
    zalogowany();
    const blokady = [{ przestrzen: 'team:a', sciezka: 'Zadania/R', folder: true, kto: 'ja', kiedy: '2026-11-19T10:00:00Z' }];
    pliki(Z1, { blokady, pisze: 'ja' });
    const w = await wywolaj('pliki_zadania', { zadanie: Z1 }, env);
    expect(dane(w)).toEqual({ zadanie: Z1, pisze: 'ja', zamkniete: false, blokady, zmiany: [] });
  });

  it.each([[undefined], [''], ['zad_123'], ['../ja'], [42]])('zły identyfikator %s: isError, bez API', async (zadanie) => {
    zalogowany();
    const w = await wywolaj('pliki_zadania', { zadanie }, env);
    expect(w.isError).toBe(true);
    expect(tekst(w)).toMatch(/identyfikator zadania/i);
    expect(api.log).toHaveLength(0);
  });

  it.each([
    [403, { kod: 'BRAK_DOSTEPU' }, /Brak dostępu/],
    [404, { kod: 'NIE_ZNALEZIONO' }, /Nie ma takiego zadania/],
    [503, { kod: 'PLIKI_WYLACZONE' }, /Heartwood/],
    [500, { kod: 'X' }, /kod: X/],
  ])('HTTP %i: isError z czytelnym tekstem', async (status, body, wzor) => {
    zalogowany();
    trasy[`/zadania/${Z1}/pliki`] = () => ({ status, body });
    const w = await wywolaj('pliki_zadania', { zadanie: Z1 }, env);
    expect(w.isError).toBe(true);
    expect(tekst(w)).toMatch(wzor);
  });
});

describe('zadania_dla_pliku', () => {
  it('blokujące (także blokadą folderu) i zmieniające; dołączyć nie można do zablokowanego', async () => {
    zalogowany();
    skrzynka();
    pliki(Z1, { blokady: [{ przestrzen: 'team:a', sciezka: 'Zadania/R', folder: true, kto: 'ja', kiedy: 't' }] });
    pliki(Z2, { zmiany: [{ przestrzen: 'team:a', sciezka: 'Zadania/R/x.txt', seq: 3, rodzaj: 'put', autor: 'ola', kiedy: 't' }] });
    pliki(Z3, { blokady: [{ przestrzen: 'team:b', sciezka: 'Zadania/R/x.txt', folder: false, kto: 'ola', kiedy: 't' }] });
    const w = await wywolaj('zadania_dla_pliku', { przestrzen: 'team:a', sciezka: '/Zadania/R/x.txt' }, env);
    expect(dane(w)).toEqual({
      blokujace: [{ id: Z1, opis: 'Raport', stan: 'w_trakcie' }],
      zmieniajace: [{ id: Z2, opis: 'Umowa', stan: 'do_akceptacji' }],
      moge_dolaczyc: [],
    });
  });

  it('wolny plik: można dołączyć do zadań, które mogę blokować; pomija zadania bez dostępu', async () => {
    zalogowany();
    skrzynka();
    pliki(Z1);
    trasy[`/zadania/${Z2}/pliki`] = () => ({ status: 403, body: { kod: 'BRAK_DOSTEPU' } });
    pliki(Z3);
    const w = await wywolaj('zadania_dla_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }, env);
    expect(dane(w)).toEqual({ blokujace: [], zmieniajace: [], moge_dolaczyc: [{ id: Z1, opis: 'Raport', stan: 'w_trakcie' }] });
  });

  it('najwyżej 30 zadań; reszta policzona jako pominięte', async () => {
    zalogowany();
    const lista = Array.from({ length: 32 }, (_, i) => ({ id: `zad_${String(i).padStart(12, '0')}`, opis: `Z${i}`, stan: 'nowe', kandydaci: ['ja'] }));
    skrzynka(lista);
    for (const z of lista) pliki(z.id);
    const w = await wywolaj('zadania_dla_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }, env);
    expect(dane(w).pominiete).toBe(2);
    expect(api.log.filter((r) => r.url.endsWith('/pliki'))).toHaveLength(30);
  });

  it('pliki wyłączone na serwerze: isError', async () => {
    zalogowany();
    skrzynka();
    for (const id of [Z1, Z2, Z3]) trasy[`/zadania/${id}/pliki`] = () => ({ status: 503, body: { kod: 'PLIKI_WYLACZONE' } });
    const w = await wywolaj('zadania_dla_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }, env);
    expect(w.isError).toBe(true);
    expect(tekst(w)).toMatch(/Heartwood/);
  });

  it.each([
    [{ przestrzen: '', sciezka: 'x' }],
    [{ przestrzen: 'team:a', sciezka: '' }],
    [{ przestrzen: 'team:a', sciezka: 'a/../b' }],
    [{ przestrzen: 'team:a\n', sciezka: 'x' }],
    [{ przestrzen: 'team:a' }],
  ])('złe argumenty %j: isError, bez API', async (args) => {
    zalogowany();
    const w = await wywolaj('zadania_dla_pliku', args, env);
    expect(w.isError).toBe(true);
    expect(api.log).toHaveLength(0);
  });
});

describe('blokada_pliku', () => {
  it('zablokowany w moim zadaniu: zadanie i kto pisze', async () => {
    zalogowany();
    skrzynka();
    pliki(Z1);
    pliki(Z2, { pisze: 'ola', blokady: [{ przestrzen: 'team:a', sciezka: 'x.txt', folder: false, kto: 'ola', kiedy: 't' }] });
    pliki(Z3);
    const w = await wywolaj('blokada_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }, env);
    expect(dane(w)).toEqual({ stan: 'zablokowany', zadanie: Z2, opis: 'Umowa', pisze: 'ola' });
  });

  it('poza moimi zadaniami: nieznane', async () => {
    zalogowany();
    skrzynka();
    for (const id of [Z1, Z2, Z3]) pliki(id);
    const w = await wywolaj('blokada_pliku', { przestrzen: 'team:a', sciezka: 'x.txt' }, env);
    expect(w.isError).toBeFalsy();
    expect(dane(w).stan).toBe('nieznane');
  });
});

describe('serwer MCP', () => {
  it('rejestruje narzędzia i odpowiada bez sesji błędem narzędzia', async () => {
    const serwerMcp = utworzSerwer(env);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const klient = new Client({ name: 'test', version: '0' });
    await Promise.all([serwerMcp.connect(a), klient.connect(b)]);
    const { tools } = await klient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['blokada_pliku', 'moje_zadania', 'pliki_zadania', 'zadania_dla_pliku']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const w = await klient.callTool({ name: 'moje_zadania', arguments: {} });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toBe('Zaloguj się: cognifly zaloguj');
    await klient.close();
  });

  it('.mcp.json uruchamia serwer z katalogu wtyczki; wersja 0.7.0', () => {
    const mcp = JSON.parse(readFileSync(join(WTYCZKA, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['cognifly-zadania']).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/zadania.mjs'] });
    expect(JSON.parse(readFileSync(join(WTYCZKA, '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe('0.7.0');
  });
});
