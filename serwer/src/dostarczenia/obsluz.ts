// Delivery watcher: re-assesses accepted PRs on GitHub signals (CI,
// pushes, merges) and on a schedule; creates the "Dostarcz" task once a
// PR and its chain are ready. Read-only towards GitHub.
import { idZdarzenia, type Zdarzenie } from '@cognifly/wspolne';
import { zapiszZdarzenie } from '../dane/historia.js';
import { pobierzZadanie, utworzZadanie } from '../dane/kolejka.js';
import { osobaPoLoginie } from '../dane/konfiguracja.js';
import { companiesWithWatches, saveWatch, updateWatch, watchOf, watchesOf, type Watch } from '../dane/dostarczenia.js';
import { buildGraph, githubFetchers, readToken } from './github.js';
import { assessChain, type Assessment } from './ocena.js';
import { refKey, type PrRef } from './zaleznosci.js';

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
 * Re-assesses every active watch of a company.
 *
 * Call: `await evaluateCompany(firma)` on a GitHub signal or schedule.
 * Expects: a company id.
 * Output: none; one failing watch does not stop the others.
 */
export async function evaluateCompany(firma: string): Promise<void> {
  for (const w of await watchesOf(firma)) {
    if (w.status === 'delivered') continue;
    await evaluateWatch(w).catch((e) => console.error('dostarczenia: ocena nieudana', { firma, pr: w.pr, blad: String(e) }));
  }
}

/**
 * Assesses one watch and applies the outcome.
 *
 * Call: `await evaluateWatch(watch)`.
 * Expects: a stored watch.
 * Output: the assessment; ready → "Dostarcz" task ensured; merged →
 * watch delivered; otherwise waiting with reasons.
 */
async function evaluateWatch(w: Watch): Promise<Assessment> {
  const result = await assess(w.firma, { repo: w.repo, number: w.pr }, w);
  const checkedAt = new Date().toISOString();
  if (result.reasons.includes('SCALONY')) {
    await updateWatch(w.firma, w.repo, w.pr, { status: 'delivered', reasons: [], checkedAt });
  } else if (result.ready) {
    const deliveryTaskId = await ensureDeliveryTask(w, result.author ?? null);
    await updateWatch(w.firma, w.repo, w.pr, { status: 'ready', reasons: [], checkedAt, deliveryTaskId });
  } else {
    await updateWatch(w.firma, w.repo, w.pr, { status: 'waiting', reasons: result.reasons, checkedAt });
  }
  return { ready: result.ready, reasons: result.reasons, order: result.order };
}

/**
 * Builds the chain from GitHub and assesses it.
 *
 * Call: `await assess(firma, root, watch)`.
 * Expects: the watch of the root (or null).
 * Output: the assessment plus the root author's login.
 */
async function assess(firma: string, root: PrRef, watch: Watch | null): Promise<Assessment & { author?: string | null }> {
  const token = await readToken(firma);
  if (!token) return { ready: false, reasons: ['BRAK_TOKENU'], order: [] };
  const { fetchPr, fetchStacked } = githubFetchers(token);
  const acceptanceOf = (r: PrRef) =>
    watch && refKey(r) === refKey(root) ? { sha: watch.acceptedSha, at: watch.acceptedAt } : null;
  const graph = await buildGraph(root, fetchPr, fetchStacked, acceptanceOf);
  return { ...assessChain(root, graph), author: graph.get(refKey(root))?.author ?? null };
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
interface Signal { detail?: { firma?: unknown } }

/**
 * Lambda entry.
 *
 * Call: by EventBridge (`detail.firma` from a GitHub signal) or the
 * scheduler (no company → every company with watches).
 * Expects: either event shape.
 * Output: none.
 */
export async function handler(event: Signal): Promise<void> {
  const firma = event.detail?.firma;
  const companies = typeof firma === 'string' && /^[a-z0-9-]{1,40}$/.test(firma) ? [firma] : await companiesWithWatches();
  for (const f of companies) await evaluateCompany(f);
}
