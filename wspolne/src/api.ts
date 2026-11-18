// Browser-safe API contract shared by the server and the desktop app.
// Type-only plus constants: no Node imports, so the app can bundle it.
// Field names are the wire format of the CogniFly HTTP API (Polish).
import type { Kanal } from './reguly.js';

/** Lifecycle state of a task, as stored by the server. */
export type TaskState =
  | 'nowe' | 'wziete' | 'w_trakcie' | 'do_akceptacji' | 'zrobione' | 'eskalowane'
  | 'odrzucone' | 'usuniete';

/** States a user may set via `POST /zadania/{id}/stan`. */
export const USER_SETTABLE_STATES = ['w_trakcie', 'do_akceptacji', 'zrobione'] as const;
export type UserSettableState = (typeof USER_SETTABLE_STATES)[number];

/** States that mean "waiting for someone to take it". */
export const WAITING_STATES = ['nowe', 'eskalowane'] as const;

/** States that need the sender's decision (a rejected task came back). */
export const RETURNED_STATES = ['odrzucone'] as const;

/** Claude Desktop session id (`CLAUDE_CODE_HOST_SESSION_ID`). */
export const THREAD_PATTERN = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who rejected a task and why (the reason is a person's free text: data). */
export interface Rejection { osoba: string; powod: string }

/** Escalation target of a task. */
export interface Escalation { osoba: string; kanaly: Kanal[] }

/** Task as returned by `/skrzynka`, `/biore` and `/stan`. */
export interface Task {
  id: string;
  firma: string;
  zdarzenieId: string;
  kandydaci: string[];
  wlasciciel?: string;
  stan: TaskState;
  utworzono: string;
  postep?: string;
  /** Server-built, structured description; the only text shown to users. */
  opis: string;
  eskalujDo?: Escalation[];
  /** Who handed the task over or asked for it; only such tasks can be rejected. */
  nadawca?: string;
  /** Set while the task is `odrzucone`. */
  odrzucenie?: Rejection;
  /** The caller's own Claude Desktop thread for this task (inbox only). */
  watek?: string;
}

/** Task id format accepted by the API (12 or 24 hex digits). */
export const TASK_ID_PATTERN = /^zad_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

/**
 * Checks an `owner/name` GitHub repository string.
 *
 * Call: `isRepo('o/r')`.
 * Expects: any string.
 * Output: true for `owner/name` made of letters, digits, `_`, `.`,
 * `-` (owner starting alphanumeric) without `..` segments.
 */
export function isRepo(repo: string): boolean {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.split('/').includes('..');
}

/** A person of the company (`GET /osoby`). */
export interface Person { osoba: string; github?: string }

/** `GET /skrzynka` → 200 */
export interface InboxResponse { zadania: Task[] }
/** `POST /zadania/{id}/biore|stan` → 200 */
export interface TaskResponse { zadanie: Task }
/** `POST /zadania/{id}/biore` → 409 */
export interface TakenResponse { kod: 'ZAJETE'; wlasciciel: string }
/**
 * Event behind a task, without data from outsiders: no `dane`, no
 * `daneRef` and no `podmiot.galaz` (branch names are free text).
 */
export interface EventSummary {
  id: string;
  czas: string;
  zrodlo: string;
  typ: string;
  opis: string;
  podmiot: Record<string, string | number>;
  wymagaPracy: boolean;
}

/** `GET /zadania/{id}` → 200; `zdarzenie` is null once history expired. */
export interface TaskDetailsResponse { zadanie: Task; zdarzenie: EventSummary | null }

/** `GET /ja` → 200: the person's id in each company they belong to. */
export interface MeResponse { firmy: { firma: string; osoba: string }[] }

/** Any error response body. */
export interface ErrorResponse { kod: string }
