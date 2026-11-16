#!/usr/bin/env node
// Guided code review: context (PR, CI, target branch, delivery chain,
// numbered diff), a draft of line comments that must each be discussed
// with the human, a verdict, and sending ONE review. Sending is only
// allowed from the human's /cognifly:wyslij-komentarz command (a plugin
// hook blocks the model from running `wyslij` itself).
// Output: one JSON object with `stan`. `gh` runs without a shell.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { wykonaj } from '../../../cli/lib/api.mjs';
import { Stan, czytaj, katalog, zapisz } from '../../../cli/lib/sesja.mjs';

const GH = process.env.COGNIFLY_GH || 'gh';
const MAX_DIFF = 200 * 1024;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK = /^zad_([0-9a-f]{12}|[0-9a-f]{24})$/;
const DECISIONS = ['zostaw', 'zmien', 'usun'];
const FAILED_CI = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];

/**
 * Reads an option value.
 *
 * Call: `opt(argv, '--repo')`.
 * Expects: argv of this script.
 * Output: the value after the flag, or undefined.
 */
function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Runs `gh api`.
 *
 * Call: `await gh(['repos/o/r/pulls/7'], { paginate, input })`.
 * Expects: gh installed and logged in; `input` = JSON body (POST).
 * Output: parsed JSON (paginated arrays flattened).
 * Throws: `Stan('BLAD_GH', { kod })` without gh's stderr (may hold
 * tokens).
 */
function gh(args, { paginate = false, input } = {}) {
  const full = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), ...args];
  return new Promise((ok, fail) => {
    const p = execFile(GH, full, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: process.env }, (e, out) => {
      if (e) return fail(new Stan('BLAD_GH', { kod: typeof e.code === 'number' ? e.code : 'NIEUDANE' }));
      try {
        const j = JSON.parse(out);
        ok(paginate && Array.isArray(j) && j.every(Array.isArray) ? j.flat() : j);
      } catch { fail(new Stan('BLAD_GH', { kod: 'ZLA_ODPOWIEDZ' })); }
    });
    if (input !== undefined) p.stdin.end(JSON.stringify(input));
  });
}

/**
 * Numbers the lines of one file patch.
 *
 * Call: `numberPatch(patch)`.
 * Expects: a unified-diff patch from GitHub (may be undefined).
 * Output: `{ text, right, left }` — text lines `R12 + x`, `L4 - y`,
 * `R13   z` (context, comment on RIGHT); sets of commentable lines.
 */
export function numberPatch(patch) {
  const right = new Set(), left = new Set(), text = [];
  let l = 0, r = 0;
  for (const line of String(patch ?? '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { l = Number(h[1]); r = Number(h[2]); text.push(line); continue; }
    if (line.startsWith('+')) { right.add(r); text.push(`R${r++} + ${line.slice(1)}`); }
    else if (line.startsWith('-')) { left.add(l); text.push(`L${l++} - ${line.slice(1)}`); }
    else if (line.startsWith(' ')) { right.add(r); text.push(`R${r}   ${line.slice(1)}`); l++; r++; }
  }
  return { text: text.join('\n'), right: [...right], left: [...left] };
}

/**
 * Summarises CI of a commit or branch.
 *
 * Call: `await ciOf(repo, ref)`.
 * Expects: a sha or branch name.
 * Output: `none` (no checks), `failure`, `pending` or `success`.
 */
async function ciOf(repo, ref) {
  const [runs, status] = await Promise.all([
    gh([`repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`]),
    gh([`repos/${repo}/commits/${encodeURIComponent(ref)}/status`]),
  ]);
  const list = runs.check_runs ?? [];
  const hasStatus = (status.total_count ?? 0) > 0;
  if (!list.length && !hasStatus) return 'none';
  if (list.some((c) => FAILED_CI.includes(c.conclusion)) || (hasStatus && ['failure', 'error'].includes(status.state))) return 'failure';
  if (list.some((c) => c.status !== 'completed') || (hasStatus && status.state === 'pending')) return 'pending';
  return 'success';
}

/**
 * Draft file name of a PR.
 *
 * Call: `draftName('o/r', 7)`.
 * Expects: a validated repo.
 * Output: `o_r_7.json`.
 */
const draftName = (repo, pr) => `${repo.replace('/', '_')}_${pr}.json`;
/** Directory of CR drafts (inside ~/.cognifly, files 600). */
const draftDir = () => join(katalog(), 'cr');

/**
 * Loads the draft or fails.
 *
 * Call: `loadDraft(repo, pr)`.
 * Expects: `kontekst` ran before.
 * Output: the draft.
 * Throws: `Stan('BRAK_KONTEKSTU')`.
 */
function loadDraft(repo, pr) {
  const d = czytaj(draftDir(), draftName(repo, pr));
  if (!d) throw new Stan('BRAK_KONTEKSTU');
  return d;
}

/** Saves the draft. */
const saveDraft = (d) => zapisz(draftDir(), draftName(d.repo, d.pr), d);

/**
 * Numbers of comments still waiting for the human's decision.
 *
 * Call: `undiscussed(draft)`.
 * Expects: a draft.
 * Output: comment numbers without a decision.
 */
const undiscussed = (d) => d.comments.filter((c) => !c.decision).map((c) => c.nr);

/**
 * `kontekst`: everything needed before reviewing.
 *
 * Call: `cr.mjs kontekst --repo o/r --pr 7 [--zadanie zad_…]`.
 * Expects: gh logged in; the CogniFly plugin configured for the chain.
 * Output: PR facts, CI of head and target branch, delivery assessment
 * (or its error state), changed files and the numbered diff. Keeps the
 * existing draft when the head commit is unchanged.
 */
async function context(repo, pr, task) {
  const p = await gh([`repos/${repo}/pulls/${pr}`]);
  const files = await gh([`repos/${repo}/pulls/${pr}/files`], { paginate: true });
  const [headCi, baseCi] = await Promise.all([ciOf(repo, p.head.sha), ciOf(repo, p.base.ref)]);
  const delivery = await wykonaj(['ocena-dostarczenia', '--repo', repo, '--pr', String(pr)]);
  const lines = {};
  let diff = '';
  for (const f of files) {
    const n = numberPatch(f.patch);
    lines[f.filename] = { right: n.right, left: n.left };
    diff += `--- ${f.filename} (${f.status})\n${n.text}\n`;
  }
  const old = czytaj(draftDir(), draftName(repo, pr));
  const keep = old && old.headSha === p.head.sha && !old.sent;
  saveDraft({
    repo, pr, task: task ?? old?.task ?? null, author: p.user.login, headSha: p.head.sha, lines,
    comments: keep ? old.comments : [], verdict: keep ? old.verdict : null, sent: false,
  });
  return {
    stan: 'OK',
    pr: { repo, numer: pr, autor: p.user.login, tytul: p.title, galazDocelowa: p.base.ref, glowa: p.head.sha, scalanie: p.mergeable_state ?? null },
    ci: { glowa: headCi, galazDocelowa: baseCi },
    dostarczenie: delivery,
    pliki: files.map((f) => ({ plik: f.filename, status: f.status })),
    diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[UCIĘTO]` : diff,
  };
}

/**
 * `dodaj`: proposes a comment on a diff line.
 *
 * Call: `cr.mjs dodaj --repo --pr --plik --linia N [--strona RIGHT|LEFT] --tresc`.
 * Expects: a draft from `kontekst`.
 * Output: `DODANO` with its number, or `LINIA_POZA_DIFFEM`.
 */
function add(repo, pr, file, line, side, body) {
  const d = loadDraft(repo, pr);
  const allowed = d.lines[file]?.[side === 'LEFT' ? 'left' : 'right'] ?? [];
  if (!allowed.includes(line)) return { stan: 'LINIA_POZA_DIFFEM' };
  if (!body) return { stan: 'BRAK_TRESCI' };
  const nr = d.comments.length + 1;
  d.comments.push({ nr, path: file, line, side, body, decision: null });
  d.verdict = null;
  saveDraft(d);
  return { stan: 'DODANO', nr };
}

/**
 * `omow`: records the human's decision on one comment.
 *
 * Call: `cr.mjs omow --repo --pr --nr N --decyzja zostaw|zmien|usun [--tresc]`.
 * Expects: the decision the human gave in the conversation.
 * Output: `ZAPISANO` with what is still undiscussed.
 */
function discuss(repo, pr, nr, decision, body) {
  const d = loadDraft(repo, pr);
  const c = d.comments.find((x) => x.nr === nr);
  if (!c) return { stan: 'BRAK_KOMENTARZA' };
  if (!DECISIONS.includes(decision)) return { stan: 'ZLA_DECYZJA' };
  if (decision === 'zmien') {
    if (!body) return { stan: 'BRAK_TRESCI' };
    c.body = body;
  }
  c.decision = decision;
  saveDraft(d);
  return { stan: 'ZAPISANO', nieomowione: undiscussed(d) };
}

/**
 * `werdykt`: accept or request changes, with a summary.
 *
 * Call: `cr.mjs werdykt --repo --pr --akceptuj|--zmiany --podsumowanie`.
 * Expects: every comment discussed.
 * Output: `WERDYKT`, or `NIEOMOWIONE` with comment numbers.
 */
function verdict(repo, pr, accept, summary) {
  const d = loadDraft(repo, pr);
  const open = undiscussed(d);
  if (open.length) return { stan: 'NIEOMOWIONE', nieomowione: open };
  if (!summary) return { stan: 'BRAK_PODSUMOWANIA' };
  d.verdict = { accept, summary };
  saveDraft(d);
  return { stan: 'WERDYKT', akceptacja: accept, komentarze: d.comments.filter((c) => c.decision !== 'usun').length };
}

/**
 * `wyslij`: sends ONE review and updates CogniFly.
 *
 * Call: only via the /cognifly:wyslij-komentarz command.
 * Expects: verdict set, every comment discussed, head unchanged.
 * Output: `WYSLANO` with the review event and CogniFly results;
 * `NIEOMOWIONE`, `BRAK_WERDYKTU`, `NOWY_COMMIT`, `JUZ_WYSLANO`.
 * Own PR → GitHub allows only COMMENT (reported as `wlasnyPr`).
 */
async function send(repo, pr) {
  const d = loadDraft(repo, pr);
  if (d.sent) return { stan: 'JUZ_WYSLANO' };
  const open = undiscussed(d);
  if (open.length) return { stan: 'NIEOMOWIONE', nieomowione: open };
  if (!d.verdict) return { stan: 'BRAK_WERDYKTU' };
  const p = await gh([`repos/${repo}/pulls/${pr}`]);
  if (p.head.sha !== d.headSha) return { stan: 'NOWY_COMMIT' };
  const me = (await gh(['user'])).login;
  const own = me.toLowerCase() === d.author.toLowerCase();
  const event = own ? 'COMMENT' : d.verdict.accept ? 'APPROVE' : 'REQUEST_CHANGES';
  const comments = d.comments.filter((c) => c.decision !== 'usun').map(({ path, line, side, body }) => ({ path, line, side, body }));
  await gh(['--method', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], {
    input: { commit_id: d.headSha, event, body: d.verdict.summary, comments },
  });
  d.sent = true;
  saveDraft(d);
  return { stan: 'WYSLANO', zdarzenie: event, komentarze: comments.length, ...(own ? { wlasnyPr: true } : {}), cognifly: await updateCogniFly(d) };
}

/**
 * Applies the verdict to the CogniFly task.
 *
 * Call: `await updateCogniFly(draft)` after the review was sent.
 * Expects: a sent draft; `task` may be null (CR without a task).
 * Output: results of the CogniFly calls, or `{ stan: 'BEZ_ZADANIA' }`.
 * Changes → task handed to the PR author; accept → delivery watch
 * started, then the CR task marked done.
 */
async function updateCogniFly(d) {
  if (!d.task) return { stan: 'BEZ_ZADANIA' };
  if (!d.verdict.accept) return { przekaz: await wykonaj(['przekaz', d.task, '--do-loginu', d.author]) };
  const watch = await wykonaj(['dostarczenie', '--repo', d.repo, '--pr', String(d.pr), '--zadanie', d.task, '--sha', d.headSha]);
  const done = await wykonaj(['stan', d.task, 'zrobione', '--postep', 'Code review zaakceptowane']);
  return { dostarczenie: watch, stan: done };
}

/**
 * Entry point: dispatches a subcommand.
 *
 * Call: `node cr.mjs <kontekst|dodaj|omow|szkic|werdykt|wyslij> --repo --pr …`.
 * Expects: valid repo and PR number.
 * Output: one JSON object; errors as `{ stan, … }`.
 */
async function main(argv) {
  const [cmd] = argv;
  const repo = opt(argv, '--repo'), pr = Number(opt(argv, '--pr'));
  if (!REPO.test(repo ?? '') || !Number.isInteger(pr) || pr < 1) return { stan: 'ZLE_ARGUMENTY' };
  const task = opt(argv, '--zadanie');
  if (task !== undefined && !TASK.test(task)) return { stan: 'ZLE_ARGUMENTY' };
  switch (cmd) {
    case 'kontekst': return context(repo, pr, task);
    case 'dodaj': return add(repo, pr, opt(argv, '--plik'), Number(opt(argv, '--linia')), opt(argv, '--strona') === 'LEFT' ? 'LEFT' : 'RIGHT', opt(argv, '--tresc'));
    case 'omow': return discuss(repo, pr, Number(opt(argv, '--nr')), opt(argv, '--decyzja'), opt(argv, '--tresc'));
    case 'szkic': {
      const d = loadDraft(repo, pr);
      return { stan: 'OK', komentarze: d.comments, nieomowione: undiscussed(d), werdykt: d.verdict, wyslane: d.sent };
    }
    case 'werdykt': return verdict(repo, pr, argv.includes('--akceptuj'), opt(argv, '--podsumowanie'));
    case 'wyslij': return send(repo, pr);
    default: return { stan: 'NIEZNANE_POLECENIE' };
  }
}

main(process.argv.slice(2))
  .catch((e) => (e instanceof Stan ? { stan: e.stan, ...e.dane } : { stan: 'BLAD', kod: 'NIEOCZEKIWANY' }))
  .then((r) => process.stdout.write(JSON.stringify(r) + '\n'));
