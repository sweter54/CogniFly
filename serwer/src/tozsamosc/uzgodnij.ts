// Hourly reconciliation of the company person registry with Identity
// (`/int/*`): repairs missed or lost events. Logs never carry e-mails.
import { activeSubs, applyMember, removeMember } from '../dane/konfiguracja.js';
import { identityClient, type IdentityClient, type IdentityPerson } from './klient.js';
import type { Log } from './zdarzenia.js';

/** Dependencies of a reconciliation run. */
export type ReconcileDeps = { client: IdentityClient; now: () => string; log: Log };

/** Writes made for one company. */
type Counts = { added: number; updated: number; removed: number };

/** Summary of a run; `failed` lists companies left unchanged by errors. */
export type ReconcileResult = Counts & { orgs: number; failed: string[] };

/**
 * Brings one company's registry in line with its Identity members.
 *
 * Call: `await reconcileOrg(org, people, at)`.
 * Expects: the full member list of the company (read before any write)
 * and the ISO time stored as the change time.
 * Output: counts of added, updated and removed people (skips are not
 * counted). Active members are applied; active registry subs absent
 * among them are removed. Throws on DynamoDB errors.
 */
async function reconcileOrg(org: string, people: IdentityPerson[], at: string): Promise<Counts> {
  const c: Counts = { added: 0, updated: 0, removed: 0 };
  const active = people.filter((p) => p.status === 'active');
  for (const p of active) {
    const r = await applyMember(org, { sub: p.sub, email: p.email, role: p.role }, at);
    if (r !== 'skipped') c[r] += 1;
  }
  const keep = new Set(active.map((p) => p.sub));
  for (const sub of await activeSubs(org)) {
    if (!keep.has(sub) && (await removeMember(org, sub, at)) === 'removed') c.removed += 1;
  }
  return c;
}

/**
 * Reconciles every company known to Identity.
 *
 * Call: `await reconcile({ client, now, log })`.
 * Expects: an Identity client; `now()` gives the ISO time of the run.
 * Output: totals and the companies that failed. A company whose member
 * list cannot be read is not written; a failure of one company is
 * logged and the others go on. Throws when the company list fails.
 */
export async function reconcile(d: ReconcileDeps): Promise<ReconcileResult> {
  const at = d.now();
  const orgs = await d.client.orgs();
  const out: ReconcileResult = { orgs: orgs.length, added: 0, updated: 0, removed: 0, failed: [] };
  for (const org of orgs) {
    try {
      const c = await reconcileOrg(org, await d.client.people(org), at);
      out.added += c.added; out.updated += c.updated; out.removed += c.removed;
    } catch (e) {
      out.failed.push(org);
      const { name, status } = (e ?? {}) as { name?: string; status?: number };
      d.log('tozsamosc: uzgadnianie firmy nieudane', { org, error: name ?? 'Error', status });
    }
  }
  return out;
}

/**
 * Runs a reconciliation, logs its summary and reports failure.
 *
 * Call: `await runReconcile(deps)`.
 * Expects: as `reconcile`.
 * Output: the summary; throws when the company list or any company
 * failed, so the scheduler and deploy trigger see the error.
 */
export async function runReconcile(d: ReconcileDeps): Promise<ReconcileResult> {
  const r = await reconcile(d);
  d.log('tozsamosc: uzgadnianie zakończone', { ...r });
  if (r.failed.length) throw new Error(`Uzgadnianie nieudane dla firm: ${r.failed.join(', ')}`);
  return r;
}

/**
 * Lambda entry point (hourly schedule and deploy trigger).
 *
 * Call: configured as handler.
 * Expects: `TOZSAMOSC_URL`, optional `AWS_REGION` (default
 * eu-central-1) and the DynamoDB table from the environment.
 * Output: the summary; throws on a missing URL or any failure.
 */
export async function handler(): Promise<ReconcileResult> {
  const url = process.env.TOZSAMOSC_URL;
  if (!url) throw new Error('Brak TOZSAMOSC_URL');
  const client = identityClient({ url, region: process.env.AWS_REGION ?? 'eu-central-1' });
  return runReconcile({ client, now: () => new Date().toISOString(), log: (m, c) => console.log(m, c) });
}
