// Which GitHub webhook deliveries should wake the delivery watcher.
// Only the company and repository travel on; no text from the payload.
import { isRepo } from './zaleznosci.js';

/** Signal for the watcher. */
export interface DeliverySignal { firma: string; repo: string }

/** Event name → actions that matter (null = every action). */
const RELEVANT: Record<string, readonly string[] | null> = {
  check_suite: ['completed'],
  check_run: ['completed'],
  status: null,
  pull_request: ['synchronize', 'closed', 'reopened', 'edited'],
  pull_request_review: ['submitted', 'dismissed'],
};

/**
 * Turns a webhook delivery into a watcher signal.
 *
 * Call: `deliverySignal(eventName, payload, firma)`.
 * Expects: a verified webhook payload (any shape).
 * Output: `{ firma, repo }` for CI results and PR/review changes,
 * null for anything else (including CI that is still running).
 */
export function deliverySignal(eventName: string, payload: unknown, firma: string): DeliverySignal | null {
  if (!Object.hasOwn(RELEVANT, eventName)) return null;
  const p = (payload ?? {}) as { action?: unknown; repository?: { full_name?: unknown } };
  const actions = RELEVANT[eventName];
  if (actions && !(typeof p.action === 'string' && actions.includes(p.action))) return null;
  const repo = p.repository?.full_name;
  return typeof repo === 'string' && isRepo(repo) ? { firma, repo } : null;
}

/** Events the regular event pipeline never sees (CI noise). */
export const CI_ONLY_EVENTS: readonly string[] = ['check_suite', 'check_run', 'status'];
