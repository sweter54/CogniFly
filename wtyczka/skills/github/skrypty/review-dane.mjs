#!/usr/bin/env node
// Dane do code review: komentarze recenzenta + diff commitów po jego ostatniej recenzji.
// Tylko odczyt (gh api GET). gh uruchamiany bez powłoki.
import { execFile } from 'node:child_process';

const GH = process.env.COGNIFLY_GH || 'gh';
const MAKS_DIFF = 200 * 1024;
const RE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const wypisz = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function arg(argv, nazwa) {
  const i = argv.indexOf(nazwa);
  return i >= 0 ? argv[i + 1] : undefined;
}

class Koniec extends Error {}
class BladGh extends Error { constructor(kod) { super('gh'); this.kod = kod; } }

function gh(sciezka, paginate = false) {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), sciezka];
  return new Promise((ok, nie) => {
    execFile(GH, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: process.env }, (e, out) => {
      if (e) return nie(new BladGh(typeof e.code === 'number' ? e.code : 'NIEUDANE'));
      try {
        const j = JSON.parse(out);
        ok(paginate && Array.isArray(j) && j.every(Array.isArray) ? j.flat() : j);
      } catch { nie(new BladGh('ZLA_ODPOWIEDZ')); }
    });
  });
}

const argv = process.argv.slice(2);
const repo = arg(argv, '--repo'), prS = arg(argv, '--pr'), rec = arg(argv, '--recenzent');
const poprawne = RE_REPO.test(repo ?? '') && /^[1-9][0-9]{0,9}$/.test(prS ?? '') && RE_LOGIN.test(rec ?? '');
if (!poprawne) wypisz({ stan: 'ZLE_ARGUMENTY' });

const czas = (s) => Date.parse(s);

if (poprawne) try {
  const baza = `repos/${repo}/pulls/${prS}`;
  const recenzje = (await gh(`${baza}/reviews`, true))
    .filter((r) => r?.user?.login === rec && r.submitted_at && !Number.isNaN(czas(r.submitted_at)));
  if (recenzje.length === 0) { wypisz({ stan: 'BRAK_RECENZJI' }); throw new Koniec(); }
  const dataRecenzji = Math.max(...recenzje.map((r) => czas(r.submitted_at)));

  const komentarze = (await gh(`${baza}/comments`, true))
    .filter((k) => k?.user?.login === rec)
    .map((k) => ({ plik: k.path ?? '', linia: k.line ?? k.original_line ?? null, tresc: String(k.body ?? '') }));

  const commity = await gh(`${baza}/commits`, true);
  const data = (c) => czas(c?.commit?.committer?.date ?? c?.commit?.author?.date);
  const przed = commity.filter((c) => data(c) <= dataRecenzji);
  const po = commity.filter((c) => data(c) > dataRecenzji);

  let diff = '', pliki = [];
  if (po.length > 0) {
    const head = commity[commity.length - 1].sha;
    const bazowy = przed.length > 0 ? przed[przed.length - 1].sha : commity[0]?.parents?.[0]?.sha;
    if (bazowy) {
      const por = await gh(`repos/${repo}/compare/${bazowy}...${head}`);
      const pl = Array.isArray(por?.files) ? por.files : [];
      pliki = pl.map((f) => f.filename).filter(Boolean);
      diff = pl.filter((f) => typeof f.patch === 'string')
        .map((f) => `--- ${f.filename}\n${f.patch}`).join('\n');
      if (diff.length > MAKS_DIFF) diff = diff.slice(0, MAKS_DIFF) + '\n[UCIĘTO: diff przekracza 200 KB]';
    }
  }
  wypisz({ stan: 'OK', komentarze, diffPoRecenzji: diff, plikiZmienione: pliki });
} catch (e) {
  if (!(e instanceof Koniec)) wypisz({ stan: 'BLAD_GH', kod: e instanceof BladGh ? e.kod : 'NIEOCZEKIWANY' });
}
