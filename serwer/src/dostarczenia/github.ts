// Read-only GitHub access for delivery chains: one GraphQL query per PR,
// a read token per company from Secrets Manager. Never writes to GitHub.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ChainNode } from './ocena.js';
import { parseDependsOn, refKey, type PrRef } from './zaleznosci.js';

/** The PR fields the query returns. */
export interface GithubPr {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  body: string | null;
  author: { login: string } | null;
  reviews: { nodes: { submittedAt: string | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/** CogniFly acceptance of a PR (from the delivery watch). */
export interface Acceptance { sha: string; at: string }

/** Fetches one PR, or null when the token cannot see it. */
export type FetchPr = (ref: PrRef) => Promise<GithubPr | null>;
/** Finds the open PR a branch belongs to (stacking), or null. */
export type FetchStacked = (repo: string, baseRef: string) => Promise<PrRef | null>;

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number state merged headRefOid baseRefName headRefName mergeable reviewDecision body author{login}
reviews(last:50,states:[CHANGES_REQUESTED]){nodes{submittedAt}}
commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}`;
const STACK_QUERY = `query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){
pullRequests(states:OPEN,headRefName:$head,first:1){nodes{number}}}}`;

/**
 * Maps a GitHub PR onto a chain node.
 *
 * Call: `nodeFromPr(ref, pr, acceptance, stackedParent)`.
 * Expects: the PR from `PR_QUERY`; acceptance from the watch (or null).
 * Output: the node; CI rollup null = success (no CI), PENDING/EXPECTED
 * = pending, FAILURE/ERROR = failure; deps = description deps + the PR
 * it is stacked on.
 */
export function nodeFromPr(ref: PrRef, pr: GithubPr, acceptance: Acceptance | null, stackedParent: PrRef | null): ChainNode {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  const deps = parseDependsOn(pr.body, ref);
  if (stackedParent && !deps.some((d) => refKey(d) === refKey(stackedParent))) deps.push(stackedParent);
  return {
    ref,
    open: pr.state === 'OPEN',
    merged: pr.merged,
    headSha: pr.headRefOid,
    mergeable: pr.mergeable === 'UNKNOWN' ? null : pr.mergeable === 'MERGEABLE',
    ci: ciState(rollup),
    reviewDecision: pr.reviewDecision,
    changesRequestedAfterAcceptance: acceptance !== null
      && pr.reviews.nodes.some((r) => r.submittedAt !== null && r.submittedAt > acceptance.at),
    acceptedSha: acceptance?.sha ?? null,
    deps,
    author: pr.author?.login ?? null,
  };
}

/**
 * Normalises a GitHub status rollup.
 *
 * Call: `ciState('SUCCESS')`.
 * Expects: a rollup state or null.
 * Output: `success` | `pending` | `failure`.
 */
function ciState(rollup: string | null): ChainNode['ci'] {
  if (rollup === null || rollup === 'SUCCESS') return 'success';
  return rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'failure';
}

/**
 * Reads a PR and its whole dependency chain.
 *
 * Call: `await buildGraph(root, fetchPr, fetchStacked, acceptanceOf)`.
 * Expects: fetchers that return null for PRs the token cannot read.
 * Output: refKey → node for every readable PR reachable from the root;
 * each PR is fetched once, so cycles terminate.
 */
export async function buildGraph(
  root: PrRef, fetchPr: FetchPr, fetchStacked: FetchStacked, acceptanceOf: (ref: PrRef) => Acceptance | null,
): Promise<Map<string, ChainNode>> {
  const graph = new Map<string, ChainNode>();
  const visited = new Set<string>();
  const queue: PrRef[] = [root];
  while (queue.length) {
    const ref = queue.shift()!;
    if (visited.has(refKey(ref))) continue;
    visited.add(refKey(ref));
    const pr = await fetchPr(ref);
    if (!pr) continue;
    const parent = pr.state === 'OPEN' ? await fetchStacked(ref.repo, pr.baseRefName) : null;
    const node = nodeFromPr(ref, pr, acceptanceOf(ref), parent);
    graph.set(refKey(ref), node);
    queue.push(...node.deps);
  }
  return graph;
}

/**
 * Sends one GraphQL query.
 *
 * Call: `await graphql(token, query, variables, fetchFn)`.
 * Expects: a read token.
 * Output: the `data` object, or null when GitHub reports the object
 * missing or not visible to the token (NOT_FOUND / FORBIDDEN / 401/403).
 * Throws: on network errors and other GitHub errors (retried later).
 */
export async function graphql(token: string, query: string, variables: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  const r = await fetchFn('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'cognifly-dostarczenia' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GraphQL HTTP ${r.status}`);
  const json = (await r.json()) as { data?: Record<string, unknown>; errors?: { type?: string }[] };
  if (json.errors?.some((e) => e.type === 'NOT_FOUND' || e.type === 'FORBIDDEN')) return null;
  if (json.errors?.length) throw new Error(`GitHub GraphQL: ${json.errors.map((e) => e.type ?? '?').join(',')}`);
  return json.data ?? null;
}

/**
 * Fetchers bound to a token.
 *
 * Call: `githubFetchers(token)`.
 * Expects: a read token.
 * Output: `{ fetchPr, fetchStacked }` for `buildGraph`.
 */
export function githubFetchers(token: string, fetchFn: typeof fetch = fetch): { fetchPr: FetchPr; fetchStacked: FetchStacked } {
  const split = (repo: string) => {
    const [owner, name] = repo.split('/');
    return { owner, name };
  };
  return {
    async fetchPr(ref) {
      const d = await graphql(token, PR_QUERY, { ...split(ref.repo), number: ref.number }, fetchFn);
      return ((d?.repository as { pullRequest?: GithubPr } | null)?.pullRequest) ?? null;
    },
    async fetchStacked(repo, baseRef) {
      const d = await graphql(token, STACK_QUERY, { ...split(repo), head: baseRef }, fetchFn);
      const n = (d?.repository as { pullRequests?: { nodes: { number: number }[] } } | null)?.pullRequests?.nodes[0];
      return n ? { repo, number: n.number } : null;
    },
  };
}

const sm = new SecretsManagerClient({});
const tokens = new Map<string, string | null>();

/**
 * Read token of a company.
 *
 * Call: `await readToken(firma)`.
 * Expects: secret `cognifly-test/github-odczyt/<firma>` (value set by
 * an admin outside of CogniFly).
 * Output: the token, or null when the secret is missing or empty (the
 * caller reports `BRAK_TOKENU`). Cached per Lambda instance.
 */
export async function readToken(firma: string): Promise<string | null> {
  if (tokens.has(firma)) return tokens.get(firma)!;
  let value: string | null = null;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: `cognifly-test/github-odczyt/${firma}` }));
    value = r.SecretString?.trim() || null;
  } catch (e) {
    if (!(e instanceof Error && e.name === 'ResourceNotFoundException')) throw e;
  }
  if (value) tokens.set(firma, value);
  return value;
}
