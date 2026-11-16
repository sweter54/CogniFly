import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRYPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'github', 'skrypty', 'cr.mjs');
const R = 'org/repo';
const SHA = 'a'.repeat(40);

let tmp, gh, dziennik, kat;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cog-cr-'));
  gh = join(tmp, 'gh.mjs');
  dziennik = join(tmp, 'gh.log');
  kat = join(tmp, 'cognifly');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Fake gh: answers by API path, logs argv and the stdin body of POSTs.
function fakeGh(odp) {
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2);
const post = a.includes('--method') && a[a.indexOf('--method') + 1] === 'POST';
const body = post ? readFileSync(0, 'utf8') : null;
appendFileSync(${JSON.stringify(dziennik)}, JSON.stringify({ a, body }) + '\\n');
const odp = ${JSON.stringify(odp)};
const sciezka = a.find((x) => x.startsWith('repos/') || x === 'user') ?? '';
const klucz = (post ? 'POST ' : '') + sciezka;
if (!(klucz in odp)) { process.stderr.write('HTTP 404 ' + klucz); process.exit(1); }
process.stdout.write(JSON.stringify(odp[klucz]));
`, { mode: 0o755 });
}
const wywolania = () => (existsSync(dziennik) ? readFileSync(dziennik, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

function cr(...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [SKRYPT, ...args], {
      env: { PATH: process.env.PATH, COGNIFLY_GH: gh, COGNIFLY_KATALOG: kat, COGNIFLY_KONFIGURACJA: join(tmp, 'brak.json'), COGNIFLY_OTWIERACZ: '' },
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => ok(out.trim() ? JSON.parse(out) : null));
  });
}

const PATCH = '@@ -1,3 +1,4 @@\n linia1\n-stara\n+nowa\n+druga\n linia3';
const odpowiedzi = (over = {}) => ({
  [`repos/${R}/pulls/7`]: { user: { login: 'ania' }, title: 'Tytuł', base: { ref: 'main' }, head: { sha: SHA, ref: 'feat' }, mergeable_state: 'clean', state: 'open' },
  [`repos/${R}/pulls/7/files`]: [[{ filename: 'a.js', status: 'modified', patch: PATCH }]],
  [`repos/${R}/commits/${SHA}/check-runs`]: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
  [`repos/${R}/commits/${SHA}/status`]: { state: 'success', total_count: 0 },
  [`repos/${R}/commits/main/check-runs`]: { check_runs: [{ status: 'completed', conclusion: 'failure' }] },
  [`repos/${R}/commits/main/status`]: { state: 'success', total_count: 0 },
  user: { login: 'michal' },
  [`POST repos/${R}/pulls/7/reviews`]: { id: 1, state: 'CHANGES_REQUESTED' },
  ...over,
});

describe('cr.mjs', () => {
  it('kontekst: PR, CI of head and target branch, numbered diff', async () => {
    fakeGh(odpowiedzi());
    const r = await cr('kontekst', '--repo', R, '--pr', '7');
    expect(r).toMatchObject({ stan: 'OK', pr: { autor: 'ania', galazDocelowa: 'main', glowa: SHA }, ci: { glowa: 'success', galazDocelowa: 'failure' } });
    expect(r.diff).toContain('R2 + nowa');
    expect(r.diff).toContain('L2 - stara');
    expect(r.diff).toContain('R1   linia1');
    expect(r.dostarczenie.stan).toBe('BRAK_KONFIGURACJI');
  });

  it('dodaj: only lines that are in the diff; numbering', async () => {
    fakeGh(odpowiedzi());
    await cr('kontekst', '--repo', R, '--pr', '7');
    expect(await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '9', '--tresc', 'x')).toEqual({ stan: 'LINIA_POZA_DIFFEM' });
    expect(await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '2', '--strona', 'LEFT', '--tresc', 'czemu usunięte?')).toMatchObject({ stan: 'DODANO', nr: 1 });
    expect(await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '3', '--tresc', 'nazwa')).toMatchObject({ stan: 'DODANO', nr: 2 });
  });

  it('werdykt and wyslij refuse until every comment is discussed', async () => {
    fakeGh(odpowiedzi());
    await cr('kontekst', '--repo', R, '--pr', '7');
    await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '2', '--tresc', 'jeden');
    await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '3', '--tresc', 'dwa');
    await cr('omow', '--repo', R, '--pr', '7', '--nr', '1', '--decyzja', 'zostaw');
    expect(await cr('werdykt', '--repo', R, '--pr', '7', '--zmiany', '--podsumowanie', 'Popraw')).toEqual({ stan: 'NIEOMOWIONE', nieomowione: [2] });
    expect(await cr('wyslij', '--repo', R, '--pr', '7')).toMatchObject({ stan: 'NIEOMOWIONE' });
    expect(wywolania().some((w) => w.a.includes('POST'))).toBe(false);
  });

  it('wyslij: one review with kept/changed comments on their lines; removed ones dropped; only once', async () => {
    fakeGh(odpowiedzi());
    await cr('kontekst', '--repo', R, '--pr', '7');
    await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '2', '--tresc', 'jeden');
    await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '3', '--tresc', 'dwa');
    await cr('dodaj', '--repo', R, '--pr', '7', '--plik', 'a.js', '--linia', '2', '--strona', 'LEFT', '--tresc', 'trzy');
    await cr('omow', '--repo', R, '--pr', '7', '--nr', '1', '--decyzja', 'zostaw');
    await cr('omow', '--repo', R, '--pr', '7', '--nr', '2', '--decyzja', 'zmien', '--tresc', 'dwa poprawione');
    await cr('omow', '--repo', R, '--pr', '7', '--nr', '3', '--decyzja', 'usun');
    expect(await cr('werdykt', '--repo', R, '--pr', '7', '--zmiany', '--podsumowanie', 'Popraw dwie rzeczy')).toMatchObject({ stan: 'WERDYKT' });
    const r = await cr('wyslij', '--repo', R, '--pr', '7');
    expect(r).toMatchObject({ stan: 'WYSLANO', zdarzenie: 'REQUEST_CHANGES', komentarze: 2 });
    const post = wywolania().find((w) => w.a.includes('POST'));
    expect(JSON.parse(post.body)).toEqual({
      commit_id: SHA, event: 'REQUEST_CHANGES', body: 'Popraw dwie rzeczy',
      comments: [{ path: 'a.js', line: 2, side: 'RIGHT', body: 'jeden' }, { path: 'a.js', line: 3, side: 'RIGHT', body: 'dwa poprawione' }],
    });
    expect(await cr('wyslij', '--repo', R, '--pr', '7')).toEqual({ stan: 'JUZ_WYSLANO' });
  });

  it('wyslij refuses when a new commit arrived after kontekst; own PR falls back to COMMENT', async () => {
    fakeGh(odpowiedzi());
    await cr('kontekst', '--repo', R, '--pr', '7');
    await cr('werdykt', '--repo', R, '--pr', '7', '--akceptuj', '--podsumowanie', 'OK');
    fakeGh(odpowiedzi({ [`repos/${R}/pulls/7`]: { user: { login: 'ania' }, base: { ref: 'main' }, head: { sha: 'b'.repeat(40) }, state: 'open' } }));
    expect(await cr('wyslij', '--repo', R, '--pr', '7')).toEqual({ stan: 'NOWY_COMMIT' });
    fakeGh(odpowiedzi({ user: { login: 'ania' } }));
    expect(await cr('wyslij', '--repo', R, '--pr', '7')).toMatchObject({ stan: 'WYSLANO', zdarzenie: 'COMMENT', wlasnyPr: true });
  });
});
