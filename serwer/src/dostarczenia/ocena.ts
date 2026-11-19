// Whether an accepted PR can be delivered now, and in which order its
// chain of dependencies has to go. Pure: the caller fetches GitHub data.
import { refKey, type PrRef } from './zaleznosci.js';

/** What the assessment needs to know about one PR. */
export interface ChainNode {
  ref: PrRef;
  open: boolean;
  merged: boolean;
  headSha: string;
  /** GitHub `mergeable`: null while GitHub is still computing it. */
  mergeable: boolean | null;
  ci: 'success' | 'pending' | 'failure';
  /** GitHub `reviewDecision` (null when the repo requires no reviews). */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  /** Someone requested changes after the CogniFly acceptance. */
  changesRequestedAfterAcceptance: boolean;
  /** Head sha accepted in CogniFly CR, or null (not accepted). */
  acceptedSha: string | null;
  deps: PrRef[];
  /** GitHub login of the PR author (who may deliver it). */
  author?: string | null;
}

/** Assessment result. */
export interface Assessment {
  ready: boolean;
  /** Why it is not ready (empty when ready). */
  reasons: string[];
  /** Unmerged PRs of the chain, dependencies first, root last. */
  order: PrRef[];
}

/**
 * Assesses a PR and its dependency chain.
 *
 * Call: `assessChain(root, graph)`; graph = refKey → node for every PR
 * that could be read (unreadable dependencies are simply absent).
 * Expects: the root node in the graph.
 * Output: ready only when the root is open, accepted on its current
 * head, not blocked by reviews, mergeable, CI green and every direct
 * dependency merged. Reasons (in this order): acceptance, reviews,
 * conflicts, CI, dependencies; `CYKL` alone when deps form a cycle.
 */
export function assessChain(root: PrRef, graph: ReadonlyMap<string, ChainNode>): Assessment {
  const node = graph.get(refKey(root));
  if (!node) return { ready: false, reasons: [`ZALEZNOSC_NIEDOSTEPNA ${refKey(root)}`], order: [] };
  if (!node.open) return { ready: false, reasons: [node.merged ? 'SCALONY' : 'ZAMKNIETY'], order: [] };
  if (hasCycle(root, graph)) return { ready: false, reasons: ['CYKL'], order: [] };
  const reasons = [...acceptanceReasons(node), ...mergeReasons(node), ...dependencyReasons(node, graph)];
  return { ready: reasons.length === 0, reasons, order: deliveryOrder(root, graph) };
}

/**
 * Reasons from acceptance and reviews.
 *
 * Call: `acceptanceReasons(node)`.
 * Expects: an open node.
 * Output: `NIE_ZAAKCEPTOWANY`, `NOWY_COMMIT`, `ZMIANY_ZADANE`,
 * `WYMAGANA_RECENZJA` as applicable (duplicates removed).
 */
function acceptanceReasons(node: ChainNode): string[] {
  const r: string[] = [];
  if (node.acceptedSha === null) r.push('NIE_ZAAKCEPTOWANY');
  else if (node.acceptedSha !== node.headSha) r.push('NOWY_COMMIT');
  if (node.changesRequestedAfterAcceptance || node.reviewDecision === 'CHANGES_REQUESTED') r.push('ZMIANY_ZADANE');
  if (node.reviewDecision === 'REVIEW_REQUIRED') r.push('WYMAGANA_RECENZJA');
  return r;
}

/**
 * Reasons from merge state and CI.
 *
 * Call: `mergeReasons(node)`.
 * Expects: an open node.
 * Output: `KONFLIKT` / `SCALANIE_SPRAWDZANE`, then `CI_BLAD` /
 * `CI_W_TOKU`.
 */
function mergeReasons(node: ChainNode): string[] {
  const r: string[] = [];
  if (node.mergeable === false) r.push('KONFLIKT');
  if (node.mergeable === null) r.push('SCALANIE_SPRAWDZANE');
  if (node.ci === 'failure') r.push('CI_BLAD');
  if (node.ci === 'pending') r.push('CI_W_TOKU');
  return r;
}

/**
 * Reasons from direct dependencies.
 *
 * Call: `dependencyReasons(node, graph)`.
 * Expects: the graph used for the assessment.
 * Output: `ZALEZNOSC_NIEDOSTEPNA <key>` for unreadable ones (never
 * assumed merged), `CZEKA_NA <key>` for unmerged ones.
 */
function dependencyReasons(node: ChainNode, graph: ReadonlyMap<string, ChainNode>): string[] {
  return node.deps.flatMap((d) => {
    const dep = graph.get(refKey(d));
    if (!dep) return [`ZALEZNOSC_NIEDOSTEPNA ${refKey(d)}`];
    return dep.merged ? [] : [`CZEKA_NA ${refKey(d)}`];
  });
}

/**
 * Detects a dependency cycle reachable from the root.
 *
 * Call: `hasCycle(root, graph)`.
 * Expects: any graph (missing nodes end a path).
 * Output: true when some PR depends on itself through the chain.
 */
function hasCycle(root: PrRef, graph: ReadonlyMap<string, ChainNode>): boolean {
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (key: string): boolean => {
    if (onPath.has(key)) return true;
    if (done.has(key)) return false;
    onPath.add(key);
    const cyclic = (graph.get(key)?.deps ?? []).some((d) => visit(refKey(d)));
    onPath.delete(key);
    done.add(key);
    return cyclic;
  };
  return visit(refKey(root));
}

/**
 * Order in which the unmerged part of the chain must be delivered.
 *
 * Call: `deliveryOrder(root, graph)` (graph known to be acyclic).
 * Expects: the root in the graph.
 * Output: unmerged, readable PRs, dependencies before dependents.
 */
function deliveryOrder(root: PrRef, graph: ReadonlyMap<string, ChainNode>): PrRef[] {
  const order: PrRef[] = [];
  const seen = new Set<string>();
  const visit = (ref: PrRef) => {
    const node = graph.get(refKey(ref));
    if (!node || node.merged || seen.has(refKey(ref))) return;
    seen.add(refKey(ref));
    node.deps.forEach(visit);
    order.push(node.ref);
  };
  visit(root);
  return order;
}
