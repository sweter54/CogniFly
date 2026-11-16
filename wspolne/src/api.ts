// Browser-safe API contract shared by the server and the desktop app.
// Type-only plus constants: no Node imports, so the app can bundle it.
// Field names are the wire format of the CogniFly HTTP API (Polish).
import type { Kanal } from './reguly.js';

/** Lifecycle state of a task, as stored by the server. */
export type TaskState =
  | 'nowe' | 'wziete' | 'w_trakcie' | 'do_akceptacji' | 'zrobione' | 'eskalowane';

/** States a user may set via `POST /zadania/{id}/stan`. */
export const USER_SETTABLE_STATES = ['w_trakcie', 'do_akceptacji', 'zrobione'] as const;
export type UserSettableState = (typeof USER_SETTABLE_STATES)[number];

/** States that mean "waiting for someone to take it". */
export const WAITING_STATES = ['nowe', 'eskalowane'] as const;

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
}

/** Task id format accepted by the API (12 or 24 hex digits). */
export const TASK_ID_PATTERN = /^zad_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

/** `GET /skrzynka` → 200 */
export interface InboxResponse { zadania: Task[] }
/** `POST /zadania/{id}/biore|stan` → 200 */
export interface TaskResponse { zadanie: Task }
/** `POST /zadania/{id}/biore` → 409 */
export interface TakenResponse { kod: 'ZAJETE'; wlasciciel: string }
/** Any error response body. */
export interface ErrorResponse { kod: string }
