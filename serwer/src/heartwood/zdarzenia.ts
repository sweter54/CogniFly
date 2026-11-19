// Turns Heartwood events from the host bus into CogniFly events,
// tasks and notifications (source `pliki`, decision D7 of the plan).
import { idZdarzenia, zwalidujZdarzenie, type Kanal, type Zdarzenie } from '@cognifly/wspolne';
import type { Task } from '@cognifly/wspolne/api';
import { przytnij } from '../powiadomienia/format.js';
import type { WyslijPowiadomienia } from '../przetwarzanie/obsluz.js';
import { taskIdOf, workStateOf } from './praca.js';

/** A Heartwood event as delivered by an EventBridge rule. */
export type HwEvent = {
  id: string;
  'detail-type': string;
  source: 'heartwood';
  time: string;
  detail: Record<string, unknown>;
};

/** Lookups needed to pick recipients and name people. */
export type Lookup = {
  personOf(firma: string, sub: string): Promise<string | null>;
  writerOf(firma: string, workId: string): Promise<string | null>;
  admins(firma: string): Promise<string[]>;
};

/** What to do with one event. */
export type Reaction = { zdarzenie: Zdarzenie; task: boolean; recipients: string[] };

/** Side effects of handling an event. */
export type HandleDeps = Lookup & {
  save(z: Zdarzenie): Promise<'NOWE' | 'DUPLIKAT'>;
  createTask(
    firma: string, zdarzenieId: string, kandydaci: string[], extra: { id: string; opis: string },
  ): Promise<unknown>;
  notify: WyslijPowiadomienia;
};

/** Event fields that differ per detail-type. */
type Draft = Pick<Zdarzenie, 'typ' | 'opis' | 'podmiot'> & { task: boolean; recipients: string[] };

type LockDetail = { org: string; ws: string; path: string; workId: string; by: string };
type RejectedDetail = { org: string; space: string; path: string; by: string; reason: Reason };
type QuotaDetail = { org: string; sub?: string; usedBytes: number; limitBytes: number };

const REASONS = {
  conflict: 'konflikt',
  no_lock: 'brak blokady',
  name: 'niedozwolona nazwa',
  excluded: 'plik wykluczony',
  quota: 'brak miejsca',
} as const;
type Reason = keyof typeof REASONS;

const OUTSIDER = 'ktoś spoza CogniFly';
const PATH_MAX = 120;
const OPIS_MAX = 300;
const GIB = 1024 ** 3;
const CHANNELS: Kanal[] = ['email', 'discord'];

/**
 * Tells whether listed fields of a detail are non-empty strings.
 *
 * Call: `hasStrings(detail, ['org', 'path'])`.
 * Expects: an event detail object.
 * Output: true when every key holds a non-empty string.
 */
function hasStrings(d: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => typeof d[k] === 'string' && d[k] !== '');
}

/**
 * Reads the detail of a lock event.
 *
 * Call: `lockDetail(detail)`.
 * Expects: detail of `lock.*`.
 * Output: typed detail, or null when a field is missing or wrong.
 */
function lockDetail(d: Record<string, unknown>): LockDetail | null {
  return hasStrings(d, ['org', 'ws', 'path', 'workId', 'by']) ? (d as LockDetail) : null;
}

/**
 * Reads the detail of `change.rejected`.
 *
 * Call: `rejectedDetail(detail)`.
 * Expects: detail of `change.rejected`.
 * Output: typed detail, or null when a field or the reason is wrong.
 */
function rejectedDetail(d: Record<string, unknown>): RejectedDetail | null {
  const ok = hasStrings(d, ['org', 'space', 'path', 'by'])
    && typeof d.reason === 'string' && Object.hasOwn(REASONS, d.reason);
  return ok ? (d as RejectedDetail) : null;
}

/**
 * Reads the detail of a quota event.
 *
 * Call: `quotaDetail(detail)`.
 * Expects: detail of `quota.*`.
 * Output: typed detail, or null when a field is missing or wrong
 * (sizes must be finite numbers >= 0, `sub` a string if present).
 */
function quotaDetail(d: Record<string, unknown>): QuotaDetail | null {
  const size = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const ok = hasStrings(d, ['org']) && size(d.usedBytes) && size(d.limitBytes)
    && (d.sub === undefined || typeof d.sub === 'string');
  return ok ? (d as QuotaDetail) : null;
}

/**
 * Builds the shown path of a file.
 *
 * Call: `shownPath('Wspólne', 'Oferty/a.docx')`.
 * Expects: a workspace or space name and a path inside it.
 * Output: `<space>/<path>` cut to 120 chars with `…`.
 */
function shownPath(space: string, path: string): string {
  return przytnij(`${space}/${path}`, PATH_MAX);
}

/**
 * Formats a size in GB (1024^3 bytes) with one decimal, Polish style.
 *
 * Call: `gb(4.5 * 1024 ** 3)`.
 * Expects: a byte count.
 * Output: e.g. `4,5 GB`.
 */
function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1).replace('.', ',')} GB`;
}

/**
 * Removes repeated person ids, keeping the first order.
 *
 * Call: `unique(['a', 'a', 'b'])`.
 * Expects: person ids.
 * Output: ids without duplicates.
 */
function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Picks people for a work: its writer, else the company admins.
 *
 * Call: `await writerOrAdmins(firma, workId, lookup)`.
 * Expects: a Heartwood work id.
 * Output: one-element list with the writer, or the admins.
 */
async function writerOrAdmins(firma: string, workId: string, l: Lookup): Promise<string[]> {
  const writer = await l.writerOf(firma, workId);
  return writer ? [writer] : unique(await l.admins(firma));
}

/**
 * Reacts to `lock.release_requested`: a task for the work's writer.
 *
 * Call: `await releaseRequested(detail, lookup)`.
 * Expects: a valid lock detail; `by` is the requester's sub.
 * Output: draft with a task for the writer (no writer: admins).
 */
async function releaseRequested(d: LockDetail, l: Lookup): Promise<Draft> {
  const from = (await l.personOf(d.org, d.by)) ?? OUTSIDER;
  return {
    typ: 'pliki.blokada.prosba',
    opis: `Prośba o zwolnienie pliku ${shownPath(d.ws, d.path)} (od: ${from})`,
    podmiot: { org: d.org, sciezka: `${d.ws}/${d.path}`, workId: d.workId },
    task: true,
    recipients: await writerOrAdmins(d.org, d.workId, l),
  };
}

/**
 * Reacts to `lock.broken`: a notification for the work's writer.
 *
 * Call: `await lockBroken(detail, lookup)`.
 * Expects: a valid lock detail.
 * Output: draft notifying the writer; no writer gives no recipients.
 */
async function lockBroken(d: LockDetail, l: Lookup): Promise<Draft> {
  const writer = await l.writerOf(d.org, d.workId);
  return {
    typ: 'pliki.blokada.zdjeta',
    opis: `Admin zdjął blokadę pliku ${shownPath(d.ws, d.path)}`,
    podmiot: { org: d.org, sciezka: `${d.ws}/${d.path}`, workId: d.workId },
    task: false,
    recipients: writer ? [writer] : [],
  };
}

/**
 * Reacts to `change.rejected`: a task on conflict, else a notice.
 *
 * Call: `await changeRejected(detail, lookup)`.
 * Expects: a valid detail; `by` is the author's sub.
 * Output: draft for the author; unknown author gives no recipients.
 */
async function changeRejected(d: RejectedDetail, l: Lookup): Promise<Draft> {
  const author = await l.personOf(d.org, d.by);
  const file = shownPath(d.space, d.path);
  const conflict = d.reason === 'conflict';
  return {
    typ: conflict ? 'pliki.zmiana.konflikt' : 'pliki.zmiana.odrzucona',
    opis: conflict
      ? `Konflikt pliku ${file}: przepisz swoje zmiany z kopii konfliktu`
      : `Zmiana pliku ${file} odrzucona (${REASONS[d.reason]})`,
    podmiot: { org: d.org, sciezka: `${d.space}/${d.path}` },
    task: conflict,
    recipients: author ? [author] : [],
  };
}

/**
 * Reacts to `quota.near` (notice) and `quota.exceeded` (task).
 *
 * Call: `await quotaEvent(detail, exceeded, lookup)`.
 * Expects: a valid quota detail.
 * Output: draft for the person of `sub`; without `sub` or when it
 * is unknown, for the company admins.
 */
async function quotaEvent(d: QuotaDetail, exceeded: boolean, l: Lookup): Promise<Draft> {
  const person = d.sub ? await l.personOf(d.org, d.sub) : null;
  const usage = `Miejsce na pliki: ${gb(d.usedBytes)} z ${gb(d.limitBytes)}`;
  return {
    typ: exceeded ? 'pliki.limit.przekroczony' : 'pliki.limit.blisko',
    opis: exceeded ? `${usage} — limit przekroczony` : `${usage} (80%)`,
    podmiot: { org: d.org },
    task: exceeded,
    recipients: person ? [person] : unique(await l.admins(d.org)),
  };
}

/**
 * Builds the draft for one event by its detail-type.
 *
 * Call: `await draftOf(event, lookup)`.
 * Expects: any Heartwood event.
 * Output: the draft, or null for other types or a bad detail.
 */
async function draftOf(e: HwEvent, l: Lookup): Promise<Draft | null> {
  const d = e.detail;
  switch (e['detail-type']) {
    case 'lock.release_requested': {
      const x = lockDetail(d);
      return x && releaseRequested(x, l);
    }
    case 'lock.broken': {
      const x = lockDetail(d);
      return x && lockBroken(x, l);
    }
    case 'change.rejected': {
      const x = rejectedDetail(d);
      return x && changeRejected(x, l);
    }
    case 'quota.near':
    case 'quota.exceeded': {
      const x = quotaDetail(d);
      return x && quotaEvent(x, e['detail-type'] === 'quota.exceeded', l);
    }
    default:
      return null;
  }
}

/**
 * Plans the reaction to a Heartwood event.
 *
 * Call: `await plan(event, lookup)`.
 * Expects: an event from the bus (`source: heartwood`); `org` is the
 * CogniFly company and the event `time` becomes `czas`.
 * Output: the CogniFly event (`zrodlo: pliki`, id from the bus event
 * id), whether it needs a task and its recipients; null for unknown
 * types, a bad shape or an event that fails validation.
 */
export async function plan(e: HwEvent, l: Lookup): Promise<Reaction | null> {
  if (e?.source !== 'heartwood' || typeof e.id !== 'string' || !e.detail || typeof e.detail !== 'object') {
    return null;
  }
  const draft = await draftOf(e, l);
  if (!draft) return null;
  const { task, recipients, ...rest } = draft;
  const w = zwalidujZdarzenie({
    id: idZdarzenia('pliki', e.id), firma: e.detail.org, zrodlo: 'pliki', czas: e.time,
    ...rest, opis: przytnij(rest.opis, OPIS_MAX), wymagaPracy: task,
  });
  return w.ok ? { zdarzenie: w.zdarzenie, task, recipients } : null;
}

/**
 * Finds the CogniFly writer of a Heartwood work.
 *
 * Call: `await writerOfWork(firma, workId, pobierzZadanie)`.
 * Expects: a work id and a task getter.
 * Output: the person id of the writer; null for work ids outside
 * `cognifly:`, missing tasks or tasks without a writer.
 */
export async function writerOfWork(
  firma: string, workId: string, get: (firma: string, id: string) => Promise<Task | null>,
): Promise<string | null> {
  const id = taskIdOf(workId);
  const t = id ? await get(firma, id) : null;
  return (t && workStateOf(t)?.writer) ?? null;
}

/**
 * Sends notifications; failures are logged, never thrown.
 *
 * Call: `await notifyAll(zdarzenie, recipients, deps)`.
 * Expects: a saved event and person ids.
 * Output: resolves after sending (email and Discord).
 */
async function notifyAll(z: Zdarzenie, recipients: string[], d: HandleDeps): Promise<void> {
  try {
    const r = await d.notify(z.firma, z, recipients.map((osoba) => ({ osoba, kanaly: CHANNELS })), 'nowe');
    if (r.bledy.length) console.error('powiadomienia: błędy', { firma: z.firma, zdarzenie: z.id, bledy: r.bledy });
  } catch (e) {
    console.error('powiadomienia: wyjątek', { firma: z.firma, zdarzenie: z.id, blad: String(e) });
  }
}

/**
 * Handles one Heartwood event (idempotent; the bus retries on error).
 *
 * Call: `await handleHeartwoodEvent(event, deps)`.
 * Expects: an event from the bus and the dependencies.
 * Output: the event is saved; with recipients, a task with id
 * `zad_<24 hex of event id>` is created (also on a duplicate, to
 * finish an interrupted run) or, for a new event, notifications are
 * sent. Unreadable events are logged and skipped.
 */
export async function handleHeartwoodEvent(e: HwEvent, d: HandleDeps): Promise<void> {
  const r = await plan(e, d);
  if (!r) {
    console.error('niepoprawne zdarzenie Heartwood, pomijam', { typ: e?.['detail-type'], id: e?.id });
    return;
  }
  const { zdarzenie: z, task, recipients } = r;
  const fresh = (await d.save(z)) === 'NOWE';
  if (recipients.length === 0) return;
  if (task) {
    await d.createTask(z.firma, z.id, recipients, { id: `zad_${z.id.slice('evt_'.length)}`, opis: z.opis });
  } else if (fresh) {
    await notifyAll(z, recipients, d);
  }
}

/**
 * Lambda entry point (target of the EventBridge rule for Heartwood).
 *
 * Call: configured as handler.
 * Expects: a Heartwood event; DynamoDB table from the environment.
 * Output: resolves when handled; throws on storage errors (retry).
 */
export async function handler(e: HwEvent): Promise<void> {
  const [{ zapiszZdarzenie }, kolejka, konf] = await Promise.all([
    import('../dane/historia.js'), import('../dane/kolejka.js'), import('../dane/konfiguracja.js'),
  ]);
  await handleHeartwoodEvent(e, {
    personOf: async (firma, sub) => {
      const firms = await konf.tozsamosc(sub);
      return firms && Object.hasOwn(firms, firma) ? firms[firma]! : null;
    },
    writerOf: (firma, workId) => writerOfWork(firma, workId, kolejka.pobierzZadanie),
    admins: konf.adminiFirmy,
    save: (z) => zapiszZdarzenie(z),
    createTask: kolejka.utworzZadanie,
    notify: async (...a) => (await import('../powiadomienia/wyslij.js')).wyslijPowiadomienia(...a),
  });
}
