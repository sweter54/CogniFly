// Delivery watcher: re-assesses accepted PRs on GitHub signals (CI,
// pushes, merges) and on a schedule; creates the "Dostarcz" task once a
// PR and its chain are ready. Read-only towards GitHub.
import { idZdarzenia, type Zdarzenie } from '@cognifly/wspolne';
import { zapiszZdarzenie } from '../dane/historia.js';
import { pobierzZadanie, utworzZadanie } from '../dane/kolejka.js';
import { osobaPoLoginie } from '../dane/konfiguracja.js';
import { companiesWithWatches, saveWatch, updateWatch, watchOf, watchesOf, type Watch } from '../dane/dostarczenia.js';
import { buildGraph, forgetToken, GithubAccessError, githubFetchers, readToken } from './github.js';
import { assessChain, type Assessment } from './ocena.js';
import { isRepo, refKey, type PrRef } from './zaleznosci.js';

/** What `startWatch` needs to register an acceptance. */
export type WatchStart = Pick<Watch, 'firma' | 'repo' | 'pr' | 'reviewTaskId' | 'reviewer' | 'acceptedSha'>;

/**
 * Registers an accepted PR and assesses it at once.
 *
 * Call: `await startWatch({ firma, repo, pr, reviewTaskId, reviewer, acceptedSha })`.
 * Expects: values validated by the API.
 * Output: the first assessment (the watch keeps running).
 */
export async function startWatch(s: WatchStart): Promise<Assessment> {
  const watch: Watch = { ...s, acceptedAt: new Date().toISOString(), status: 'waiting', reasons: [] };
  await saveWatch(watch);
  return evaluateWatch(watch);
}

/**
 * Assesses a PR for anyone who asks (CR context in Claude).
 *
 * Call: `await assessPr(firma, repo, pr)`.
 * Expects: a company and a PR.
 * Output: the assessment, using the CogniFly acceptance when the PR is
 * watched; `BRAK_TOKENU` without a read token.
 */
export async function assessPr(firma: string, repo: string, pr: number): Promise<Assessment> {
  const watch = await watchOf(firma, repo, pr);
  return assess(firma, { repo, number: pr }, watch);
}

/**
 * Whether a watch should be re-assessed now.
 *
 * Call: `shouldEvaluate(watch, repo)`.
 * Expects: a stored watch; `repo` from a GitHub signal, or undefined
 * for the scheduled sweep.
 * Output: never for `delivered`; for a signal — only when it comes from
 * the watched PR's repo or a repo of its chain (watches without a known
 * chain are always assessed); `closed` watches only on a signal from
 * their own repo (a reopened PR revives them), never on the schedule.
 */
export function shouldEvaluate(w: Watch, repo?: string): boolean {
  if (w.status === 'delivered') return false;
  const own = !!repo && w.repo.toLowerCase() === repo.toLowerCase();
  if (w.status === 'closed') return own;
  if (!repo || own) return true;
  return !w.repos?.length || w.repos.includes(repo.toLowerCase());
}

/**
 * Re-assesses the active watches of a company.
 *
 * Call: `await evaluateCompany(firma, repo?)` on a GitHub signal (with
 * its repo) or on the schedule (without).
 * Expects: a company id.
 * Output: none; one failing watch does not stop the others.
 */
export async function evaluateCompany(firma: string, repo?: string): Promise<void> {
  for (const w of await watchesOf(firma)) {
    if (!shouldEvaluate(w, repo)) continue;
    await evaluateWatch(w).catch((e) => console.error('dostarczenia: ocena nieudana', { firma, pr: w.pr, blad: String(e) }));
  }
}

/**
 * Assesses one watch and applies the outcome.
 *
 * Call: `await evaluateWatch(watch)`.
 * Expects: a stored watch.
 * Output: the assessment; ready → "Dostarcz" task ensured; merged →
 * watch delivered; closed unmerged → watch closed (no more sweeps);
 * otherwise waiting with reasons.
 */
async function evaluateWatch(w: Watch): Promise<Assessment> {
  const result = await assess(w.firma, { repo: w.repo, number: w.pr }, w);
  const checkedAt = new Date().toISOString();
  const repos = result.repos;
  if (result.reasons.includes('SCALONY')) {
    await updateWatch(w.firma, w.repo, w.pr, { status: 'delivered', reasons: [], checkedAt });
  } else if (result.reasons.includes('ZAMKNIETY')) {
    await updateWatch(w.firma, w.repo, w.pr, { status: 'closed', reasons: result.reasons, checkedAt });
  } else if (result.ready) {
    const deliveryTaskId = await ensureDeliveryTask(w, result.author ?? null);
    await updateWatch(w.firma, w.repo, w.pr, { status: 'ready', reasons: [], checkedAt, deliveryTaskId, repos });
  } else {
    await updateWatch(w.firma, w.repo, w.pr, { status: 'waiting', reasons: result.reasons, checkedAt, repos });
  }
  return { ready: result.ready, reasons: result.reasons, order: result.order };
}

/**
 * Builds the chain from GitHub and assesses it.
 *
 * Call: `await assess(firma, root, watch)`.
 * Expects: the watch of the root (or null).
 * Output: the assessment plus the root author's login and the chain's
 * repositories (lowercase); a chain longer than `MAX_CHAIN` is never
 * ready (`LANCUCH_ZA_DLUGI`). A rejected or rate-limited token gives its
 * own reason (`TOKEN_NIEWAZNY`, `TOKEN_BEZ_UPRAWNIEN`, `LIMIT_GITHUB`).
 */
async function assess(firma: string, root: PrRef, watch: Watch | null): Promise<Assessment & { author?: string | null; repos?: string[] }> {
  const token = await readToken(firma);
  if (!token) return { ready: false, reasons: ['BRAK_TOKENU'], order: [] };
  const { fetchPr, fetchStacked } = githubFetchers(token);
  const acceptanceOf = (r: PrRef) =>
    watch && refKey(r) === refKey(root) ? { sha: watch.acceptedSha, at: watch.acceptedAt } : null;
  let built: Awaited<ReturnType<typeof buildGraph>>;
  try {
    built = await buildGraph(root, fetchPr, fetchStacked, acceptanceOf);
  } catch (e) {
    if (!(e instanceof GithubAccessError)) throw e;
    if (e.reason !== 'LIMIT_GITHUB') forgetToken(firma);
    return { ready: false, reasons: [e.reason], order: [] };
  }
  const { graph, truncated } = built;
  const result = assessChain(root, graph);
  if (truncated) result.reasons.push('LANCUCH_ZA_DLUGI');
  const repos = [...new Set([root.repo, ...[...graph.values()].flatMap((n) => [n.ref.repo, ...n.deps.map((d) => d.repo)])]
    .map((r) => r.toLowerCase()))];
  return { ...result, ready: result.ready && !truncated, author: graph.get(refKey(root))?.author ?? null, repos };
}

/**
 * Creates (once) the "Dostarcz" task for the author and the reviewer.
 *
 * Call: `await ensureDeliveryTask(watch, authorLogin)`.
 * Expects: a ready watch.
 * Output: the task id. The event and task ids derive from the PR and
 * the accepted sha, so repeated signals create nothing new. `opis` is
 * built from structured fields only.
 */
async function ensureDeliveryTask(w: Watch, authorLogin: string | null): Promise<string> {
  const author = authorLogin ? await osobaPoLoginie(w.firma, authorLogin) : null;
  const event: Zdarzenie = {
    id: idZdarzenia('github', `dostarcz:${refKey({ repo: w.repo, number: w.pr })}:${w.acceptedSha}`),
    firma: w.firma, zrodlo: 'github', typ: 'github.pr.gotowy_do_dostarczenia', czas: new Date().toISOString(),
    podmiot: { repo: w.repo, pr: w.pr, ...(authorLogin ? { autor: authorLogin } : {}) },
    opis: `Dostarcz PR #${w.pr} (repo ${w.repo}) — CI zielone, zależności scalone`,
    wymagaPracy: true,
  };
  await zapiszZdarzenie(event);
  const id = `zad_${event.id.slice('evt_'.length)}`;
  const existing = await pobierzZadanie(w.firma, id);
  if (existing) return existing.id;
  const candidates = [...new Set([author, w.reviewer].filter((o): o is string => !!o))];
  return (await utworzZadanie(w.firma, event.id, candidates, { id, opis: event.opis })).id;
}

/** EventBridge signal from the webhook, or an empty scheduler event. */
interface Signal { detail?: { firma?: unknown; repo?: unknown } }

/**
 * Lambda entry.
 *
 * Call: by EventBridge (`detail.firma` and `detail.repo` from a GitHub
 * signal) or the scheduler (no company → every company with watches).
 * Expects: either event shape.
 * Output: none. A signal re-assesses only the watches its repo concerns.
 */
export async function handler(event: Signal): Promise<void> {
  const firma = event.detail?.firma;
  const repo = event.detail?.repo;
  if (typeof firma === 'string' && /^[a-z0-9-]{1,40}$/.test(firma)) {
    await evaluateCompany(firma, typeof repo === 'string' && isRepo(repo) ? repo : undefined);
    return;
  }
  for (const f of await companiesWithWatches()) await evaluateCompany(f);
}
