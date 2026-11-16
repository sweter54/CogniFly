import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKRYPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'github', 'skrypty', 'review-dane.mjs');

let tmp, gh, dziennik;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cog-rev-'));
  gh = join(tmp, 'gh.mjs');
  dziennik = join(tmp, 'wywolania.log');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Fałszywe gh: odpowiada po argv, loguje wywołania. Skrypt z shebangiem uruchamiany przez node.
function fakeGh(odpowiedzi, { padnij = false, kodBledu = '404 ' } = {}) {
  writeFileSync(gh, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(dziennik)}, JSON.stringify(a) + '\\n');
if (${padnij}) { process.stderr.write('token ghp_SEKRET'); process.exit(4); }
const odp = ${JSON.stringify(odpowiedzi)};
const sciezka = a.find((x) => x.startsWith('repos/')) ?? '';
const klucz = Object.keys(odp).find((k) => sciezka === k);
if (!klucz) { process.stderr.write(${JSON.stringify(kodBledu)} + ' ' + sciezka); process.exit(1); }
process.stdout.write(JSON.stringify(odp[klucz]));
`, { mode: 0o755 });
}

function uruchom(args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [SKRYPT, ...args], { env: { PATH: process.env.PATH, COGNIFLY_GH: gh } });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => ok({ json: out.trim() ? JSON.parse(out) : null, out, err, code }));
  });
}
const wywolania = () => (existsSync(dziennik) ? readFileSync(dziennik, 'utf8').trim().split('\n').filter(Boolean) : []);

const R = 'org/repo';
const baza = () => ({
  [`repos/${R}/pulls/7/comments`]: [
    { user: { login: 'anna' }, pull_request_review_id: 102, created_at: '2026-01-03T09:59:00Z', path: 'a.js', line: 3, body: 'popraw nazwę' },
    { user: { login: 'bob' }, pull_request_review_id: 102, path: 'b.js', line: 9, body: 'cudzy komentarz' },
    { user: { login: 'anna' }, pull_request_review_id: 102, created_at: '2026-01-03T09:59:30Z', path: 'c.js', line: null, original_line: 12, body: 'jeszcze to' },
    { user: { login: 'anna' }, pull_request_review_id: 101, path: 'stary.js', line: 1, body: 'komentarz ze starej recenzji' },
  ],
  [`repos/${R}/pulls/7/reviews`]: [
    { id: 101, user: { login: 'anna' }, submitted_at: '2026-01-02T10:00:00Z', commit_id: 'aaa1111' },
    { id: 103, user: { login: 'bob' }, submitted_at: '2026-01-05T10:00:00Z', commit_id: 'aaa4444' },
    { id: 102, user: { login: 'anna' }, submitted_at: '2026-01-03T10:00:00Z', commit_id: 'aaa2222' },
  ],
  [`repos/${R}/pulls/7`]: { head: { sha: 'aaa4444' } },
  [`repos/${R}/pulls/7/commits`]: [
    { sha: 'aaa1111', commit: { committer: { date: '2026-01-01T10:00:00Z' } } },
    { sha: 'aaa2222', commit: { committer: { date: '2026-01-03T09:00:00Z' } } },
    { sha: 'aaa3333', commit: { committer: { date: '2026-01-04T10:00:00Z' } } },
    { sha: 'aaa4444', commit: { committer: { date: '2026-01-04T12:00:00Z' } } },
  ],
  [`repos/${R}/compare/aaa2222...aaa4444`]: { files: [{ filename: 'a.js', patch: '@@ -1 +1 @@\n-x\n+y' }, { filename: 'bin.png' }] },
});

describe('review-dane', () => {
  it('zwraca tylko komentarze recenzenta i diff commitów po jego ostatniej recenzji', async () => {
    fakeGh(baza());
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.code).toBe(0);
    expect(r.json.stan).toBe('OK');
    expect(r.json.komentarze).toEqual([
      { plik: 'a.js', linia: 3, tresc: 'popraw nazwę', idRecenzji: 102, utworzono: '2026-01-03T09:59:00Z' },
      { plik: 'c.js', linia: 12, tresc: 'jeszcze to', idRecenzji: 102, utworzono: '2026-01-03T09:59:30Z' },
    ]);
    expect(JSON.stringify(r.json)).not.toContain('starej recenzji');
    expect(JSON.stringify(r.json)).not.toContain('cudzy komentarz');
    expect(r.json.plikiZmienione).toEqual(['a.js', 'bin.png']);
    expect(r.json.diffPoRecenzji).toContain('a.js');
    expect(r.json.diffPoRecenzji).toContain('+y');
    const log = wywolania().map((l) => JSON.parse(l));
    expect(log.some((a) => a.includes(`repos/${R}/compare/aaa2222...aaa4444`))).toBe(true);
    // żadnych metod modyfikujących
    expect(log.every((a) => !a.some((x) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(x)))).toBe(true);
  });

  it('brak zmian po recenzji (commit_id == head) -> pusty diff, bez compare', async () => {
    const o = baza();
    o[`repos/${R}/pulls/7/reviews`][2].commit_id = 'aaa4444';
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json).toMatchObject({ stan: 'OK', diffPoRecenzji: '', plikiZmienione: [] });
    expect(wywolania().some((l) => l.includes('compare'))).toBe(false);
  });

  it('commit z datą sprzed recenzji, ale wypchnięty po niej (poza commit_id), trafia do diffu', async () => {
    const o = baza();
    // wszystkie daty przed recenzją (rebase/amend, późny push), a commit_id = aaa2222
    o[`repos/${R}/pulls/7/commits`] = o[`repos/${R}/pulls/7/commits`].map((c) => ({ ...c, commit: { committer: { date: '2026-01-01T00:00:00Z' } } }));
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.diffPoRecenzji).toContain('+y');
    expect(r.json.plikiZmienione).toEqual(['a.js', 'bin.png']);
    const log = wywolania().map((l) => JSON.parse(l));
    expect(log.some((a) => a.includes(`repos/${R}/compare/aaa2222...aaa4444`))).toBe(true);
  });

  it('head z pulls/N, nie z ostatniego commitu listy', async () => {
    const o = baza();
    o[`repos/${R}/pulls/7`] = { head: { sha: 'aaa9999' } };
    o[`repos/${R}/compare/aaa2222...aaa9999`] = { files: [{ filename: 'z.js', patch: '+z' }] };
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.plikiZmienione).toEqual(['z.js']);
  });

  it('brak commit_id w recenzji -> awaryjny podział po datach', async () => {
    const o = baza();
    delete o[`repos/${R}/pulls/7/reviews`][2].commit_id;
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.diffPoRecenzji).toContain('+y');
    const log = wywolania().map((l) => JSON.parse(l));
    expect(log.some((a) => a.includes(`repos/${R}/compare/aaa2222...aaa4444`))).toBe(true);
  });

  it('login recenzenta bez rozróżniania wielkości liter; dozwolony sufiks [bot]', async () => {
    fakeGh(baza());
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'ANNA']);
    expect(r.json.stan).toBe('OK');
    expect(r.json.komentarze).toHaveLength(2);
    const o = baza();
    o[`repos/${R}/pulls/7/reviews`] = [{ id: 9, user: { login: 'Copilot[bot]' }, submitted_at: '2026-01-03T10:00:00Z', commit_id: 'aaa4444' }];
    o[`repos/${R}/pulls/7/comments`] = [{ user: { login: 'copilot[bot]' }, pull_request_review_id: 9, path: 'x.js', line: 1, body: 'bot' }];
    fakeGh(o);
    const b = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'copilot[bot]']);
    expect(b.json.stan).toBe('OK');
    expect(b.json.komentarze.map((k) => k.tresc)).toEqual(['bot']);
  });

  it('compare 404 (commit zniknął po force-push) -> awaryjny podział po datach, nie BLAD_GH', async () => {
    const o = baza();
    delete o[`repos/${R}/compare/aaa2222...aaa4444`];
    // po datach: ostatni commit przed recenzją (2026-01-03T10:00) to aaa2222 -> ten sam; użyj zniknięcia innego commit_id
    o[`repos/${R}/pulls/7/reviews`][2].commit_id = 'dead999';
    o[`repos/${R}/compare/aaa2222...aaa4444`] = { files: [{ filename: 'a.js', patch: '+z' }] };
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.stan).toBe('OK');
    expect(r.json.diffPoRecenzji).toContain('+z');
    const log = wywolania().map((l) => JSON.parse(l));
    expect(log.some((a) => a.includes(`repos/${R}/compare/dead999...aaa4444`))).toBe(true);
    expect(log.some((a) => a.includes(`repos/${R}/compare/aaa2222...aaa4444`))).toBe(true);
  });

  it('inny błąd compare niż 404 nadal -> BLAD_GH', async () => {
    const o = baza();
    delete o[`repos/${R}/compare/aaa2222...aaa4444`];
    fakeGh(o, { kodBledu: '500 serwer' });
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.stan).toBe('BLAD_GH');
  });

  it('brak recenzji recenzenta -> BRAK_RECENZJI', async () => {
    fakeGh(baza());
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'ktos']);
    expect(r.json).toEqual({ stan: 'BRAK_RECENZJI' });
  });

  it('zły argument -> ZLE_ARGUMENTY i gh nie jest wołane', async () => {
    fakeGh(baza());
    const zle = [
      ['--repo', 'bez-ukosnika', '--pr', '7', '--recenzent', 'anna'],
      ['--repo', 'a/b/c', '--pr', '7', '--recenzent', 'anna'],
      ['--repo', 'a/b;rm', '--pr', '7', '--recenzent', 'anna'],
      ['--repo', R, '--pr', '0', '--recenzent', 'anna'],
      ['--repo', R, '--pr', '-1', '--recenzent', 'anna'],
      ['--repo', R, '--pr', '7x', '--recenzent', 'anna'],
      ['--repo', R, '--pr', '7', '--recenzent', '-anna'],
      ['--repo', R, '--pr', '7', '--recenzent', 'a'.repeat(40)],
      ['--repo', R, '--pr', '7', '--recenzent', 'a b'],
      ['--repo', R, '--pr', '7'],
      [],
    ];
    for (const a of zle) {
      const r = await uruchom(a);
      expect(r.json, JSON.stringify(a)).toEqual({ stan: 'ZLE_ARGUMENTY' });
    }
    expect(wywolania()).toEqual([]);
  });

  it('awaria gh -> BLAD_GH z kodem, bez tokenów', async () => {
    fakeGh({}, { padnij: true });
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json).toEqual({ stan: 'BLAD_GH', kod: 4 });
    expect(r.out + r.err).not.toContain('SEKRET');
  });

  it('ucina zbyt duży diff ze znacznikiem', async () => {
    const o = baza();
    o[`repos/${R}/compare/aaa2222...aaa4444`] = { files: [{ filename: 'a.js', patch: 'x'.repeat(300_000) }] };
    fakeGh(o);
    const r = await uruchom(['--repo', R, '--pr', '7', '--recenzent', 'anna']);
    expect(r.json.diffPoRecenzji.length).toBeLessThan(205_000);
    expect(r.json.diffPoRecenzji).toContain('[UCIĘTO');
  });
});
