// Copies Identity person events (source `tozsamosc`) from the host bus
// into the company person registry. Logs never carry e-mails.
import type { Member } from '../dane/konfiguracja.js';

/** An Identity event as delivered by an EventBridge rule. */
export type IdentityEvent = { 'detail-type': string; time: string; detail: unknown };

/** Log sink: a message and a context without e-mails or tokens. */
export type Log = (msg: string, ctx: Record<string, unknown>) => void;

/** Registry writes and the log used by the consumer. */
export type EventDeps = {
  applyMember(firma: string, m: Member, at: string): Promise<'added' | 'updated' | 'skipped'>;
  removeMember(firma: string, sub: string, at: string): Promise<'removed' | 'skipped'>;
  log: Log;
};

/** What one supported event asks for. */
type Action =
  | { kind: 'apply'; org: string; member: Member }
  | { kind: 'remove'; org: string; sub: string };

/**
 * Reads the listed non-empty string fields of a detail.
 *
 * Call: `strings(detail, ['org', 'sub'])`.
 * Expects: any detail value (untrusted).
 * Output: the object when every key holds a non-empty string, else null.
 */
function strings<K extends string>(d: unknown, keys: K[]): (Record<K, string> & Record<string, unknown>) | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  return keys.every((k) => typeof o[k] === 'string' && o[k] !== '') ? (o as Record<K, string>) : null;
}

/**
 * Tells whether a value is an Identity role.
 *
 * Call: `isRole('admin')`.
 * Expects: any value.
 * Output: true for `admin` and `member`.
 */
const isRole = (r: unknown): r is Member['role'] => r === 'admin' || r === 'member';

/**
 * Turns an event into a registry action.
 *
 * Call: `actionOf(event)`.
 * Expects: any event from the bus.
 * Output: the action for `person.added` (needs e-mail),
 * `person.role_changed` (role only) and `person.removed`; null for
 * other types (`org.*` included) or a bad detail.
 */
function actionOf(e: IdentityEvent): Action | null {
  switch (e['detail-type']) {
    case 'person.added': {
      const d = strings(e.detail, ['org', 'sub', 'email']);
      return d && isRole(d.role)
        ? { kind: 'apply', org: d.org, member: { sub: d.sub, email: d.email, role: d.role } } : null;
    }
    case 'person.role_changed': {
      const d = strings(e.detail, ['org', 'sub']);
      return d && isRole(d.role) ? { kind: 'apply', org: d.org, member: { sub: d.sub, role: d.role } } : null;
    }
    case 'person.removed': {
      const d = strings(e.detail, ['org', 'sub']);
      return d && { kind: 'remove', org: d.org, sub: d.sub };
    }
    default:
      return null;
  }
}

/**
 * Handles one Identity event (idempotent; the bus retries on error).
 *
 * Call: `await handleIdentityEvent(event, deps)`.
 * Expects: an event from the bus; its `time` is the change time.
 * Output: the person is added, updated or marked removed and the
 * outcome is logged (unknown sub of a role change: `skipped`). Other
 * types and bad details are logged and skipped without throwing, so
 * the DLQ stays empty. Storage errors propagate (bus retry).
 */
export async function handleIdentityEvent(e: IdentityEvent, d: EventDeps): Promise<void> {
  const type = e?.['detail-type'];
  const a = e && typeof e.time === 'string' ? actionOf(e) : null;
  if (!a) {
    d.log('tozsamosc: zdarzenie pominięte', { type });
    return;
  }
  const result = a.kind === 'apply'
    ? await d.applyMember(a.org, a.member, e.time)
    : await d.removeMember(a.org, a.sub, e.time);
  const sub = a.kind === 'apply' ? a.member.sub : a.sub;
  d.log('tozsamosc: zdarzenie obsłużone', { type, org: a.org, sub, result });
}

/**
 * Lambda entry point (target of the EventBridge rule for Identity).
 *
 * Call: configured as handler.
 * Expects: an Identity event; DynamoDB table from the environment.
 * Output: resolves when handled; throws on storage errors (retry).
 */
export async function handler(e: IdentityEvent): Promise<void> {
  const { applyMember, removeMember } = await import('../dane/konfiguracja.js');
  await handleIdentityEvent(e, { applyMember, removeMember, log: (m, c) => console.log(m, c) });
}
