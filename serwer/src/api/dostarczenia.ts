// API of delivery watches: start a watch after an accepted CR, and
// assess any PR on demand (CR context in Claude).
import { zdarzenieZadania } from '../dane/historia.js';
import { pobierzZadanie } from '../dane/kolejka.js';
import { assessPr, startWatch } from '../dostarczenia/obsluz.js';
import { isRepo } from '../dostarczenia/zaleznosci.js';
import { HttpBlad, obiektJson, type Kontekst, type Odpowiedz } from './kontekst.js';
import { sprawdzId } from './zadania.js';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Validates a PR number.
 *
 * Call: `prNumber(value)`.
 * Expects: a number or numeric string.
 * Output: a positive integer.
 * Throws: `HttpBlad(400, 'ZLY_PR')`.
 */
export function prNumber(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new HttpBlad(400, 'ZLY_PR');
  return n;
}

/**
 * Validates a repository name.
 *
 * Call: `repoName(value)`.
 * Expects: anything.
 * Output: the `owner/name` string.
 * Throws: `HttpBlad(400, 'ZLE_REPO')`.
 */
export function repoName(value: unknown): string {
  if (typeof value !== 'string' || !isRepo(value)) throw new HttpBlad(400, 'ZLE_REPO');
  return value;
}

/**
 * Whether the task's event concerns this PR.
 *
 * Call: `zgodnyPr(podmiot, repo, pr)`.
 * Expects: the event `podmiot` (or undefined when the event expired).
 * Output: true only when the event names this repo (case-insensitive)
 * and PR number; false when it names another one, when it lacks either
 * (e.g. a task from outside GitHub) or when the event expired (fail closed).
 */
function zgodnyPr(podmiot: { repo?: unknown; pr?: unknown } | undefined, repo: string, pr: number): boolean {
  if (typeof podmiot?.repo !== 'string' || podmiot.pr === undefined || podmiot.pr === null) return false;
  return podmiot.repo.toLowerCase() === repo.toLowerCase() && Number(podmiot.pr) === pr;
}

/**
 * `POST /dostarczenia {repo, pr, zadanieId, sha}`: CR accepted.
 *
 * Call: by the plugin after an accepting review was sent.
 * Expects: the caller owns the CR task; `sha` = reviewed head commit;
 * the task's (unexpired) event must name this repo and PR.
 * Output: 200 `{ ocena }` with the first assessment; 400 for bad
 * input, 404 unknown task, 403 not the owner (`BRAK_DOSTEPU`) or a task
 * of another PR (`INNY_PR`).
 */
export async function rozpocznij(k: Kontekst, surowe: string | null | undefined): Promise<Odpowiedz> {
  const b = obiektJson(surowe);
  const repo = repoName(b.repo);
  const pr = prNumber(b.pr);
  if (typeof b.sha !== 'string' || !SHA.test(b.sha)) throw new HttpBlad(400, 'ZLY_SHA');
  const task = await pobierzZadanie(k.firma, sprawdzId(typeof b.zadanieId === 'string' ? b.zadanieId : undefined));
  if (!task) throw new HttpBlad(404, 'NIE_ZNALEZIONO');
  if (task.wlasciciel !== k.osoba) throw new HttpBlad(403, 'BRAK_DOSTEPU');
  const podmiot = (await zdarzenieZadania(k.firma, task.zdarzenieId, task.utworzono))?.podmiot as
    { repo?: unknown; pr?: unknown } | undefined;
  if (!zgodnyPr(podmiot, repo, pr)) throw new HttpBlad(403, 'INNY_PR');
  const ocena = await startWatch({ firma: k.firma, repo, pr, reviewTaskId: task.id, reviewer: k.osoba, acceptedSha: b.sha });
  return { status: 200, body: { ocena } };
}

/**
 * `GET /dostarczenia/ocena?repo&pr`: can this PR be delivered now?
 *
 * Call: by the plugin when preparing a CR.
 * Expects: query `repo` and `pr`.
 * Output: 200 `{ ocena }` (`ready`, `reasons`, `order`).
 */
export async function ocena(k: Kontekst, q: Record<string, string | undefined> = {}): Promise<Odpowiedz> {
  const result = await assessPr(k.firma, repoName(q.repo), prNumber(q.pr));
  return { status: 200, body: { ocena: result } };
}
