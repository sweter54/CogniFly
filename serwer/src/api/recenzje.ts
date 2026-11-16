// Authors ask colleagues to review their PR: the list of people in the
// company and the review request that creates a task for reviewers.
import { randomBytes } from 'node:crypto';
import { idZdarzenia, type Zdarzenie } from '@cognifly/wspolne';
import { zapiszZdarzenie } from '../dane/historia.js';
import { utworzZadanie } from '../dane/kolejka.js';
import { osobyFirmy } from '../dane/konfiguracja.js';
import { githubFetchers, readToken } from '../dostarczenia/github.js';
import { prNumber, repoName } from './dostarczenia.js';
import { HttpBlad, obiektJson, type Kontekst, type Odpowiedz } from './kontekst.js';

const MAX_REVIEWERS = 10;

/**
 * `GET /osoby`: people of the caller's company.
 *
 * Call: by the plugin and the app (reviewer picker).
 * Expects: a logged-in member.
 * Output: 200 `{ osoby: [{ osoba, github? }] }` — no e-mail addresses.
 */
export async function osoby(k: Kontekst): Promise<Odpowiedz> {
  return { status: 200, body: { osoby: await osobyFirmy(k.firma) } };
}

/**
 * Validates the reviewer list against the company.
 *
 * Call: `await reviewers(firma, value)`.
 * Expects: anything from the request body.
 * Output: unique ids of company members (1…10).
 * Throws: `HttpBlad(400, 'ZLI_RECENZENCI')`.
 */
async function reviewers(firma: string, value: unknown): Promise<string[]> {
  const list = Array.isArray(value) ? [...new Set(value)] : [];
  if (!list.length || list.length > MAX_REVIEWERS || !list.every((x) => typeof x === 'string')) {
    throw new HttpBlad(400, 'ZLI_RECENZENCI');
  }
  const members = new Set((await osobyFirmy(firma)).map((o) => o.osoba));
  if (!list.every((x) => members.has(x as string))) throw new HttpBlad(400, 'ZLI_RECENZENCI');
  return list as string[];
}

/**
 * Checks the PR on GitHub when the company has a read token.
 *
 * Call: `await checkPr(firma, repo, pr)`.
 * Expects: validated repo and number.
 * Output: the PR author's login (or null when unchecked/unknown).
 * Throws: `HttpBlad(404, 'BRAK_PR')`, `HttpBlad(409, 'PR_ZAMKNIETY')`.
 */
async function checkPr(firma: string, repo: string, pr: number): Promise<string | null> {
  const token = await readToken(firma);
  if (!token) return null;
  const found = await githubFetchers(token).fetchPr({ repo, number: pr });
  if (!found) throw new HttpBlad(404, 'BRAK_PR');
  if (found.state !== 'OPEN') throw new HttpBlad(409, 'PR_ZAMKNIETY');
  return found.author?.login ?? null;
}

/**
 * `POST /recenzje {repo, pr, recenzenci}`: ask for a code review.
 *
 * Call: by the author (plugin or app).
 * Expects: reviewers from `GET /osoby`.
 * Output: 200 `{ zadanie }` — a new "Prośba o recenzję" task for the
 * reviewers, backed by an event in history (so guided CR finds the
 * repo/PR). `opis` is built from structured fields only.
 */
export async function zglos(k: Kontekst, surowe: string | null | undefined): Promise<Odpowiedz> {
  const b = obiektJson(surowe);
  const repo = repoName(b.repo);
  const pr = prNumber(b.pr);
  const kandydaci = await reviewers(k.firma, b.recenzenci);
  const autor = await checkPr(k.firma, repo, pr);
  const event: Zdarzenie = {
    id: idZdarzenia('github', `zgloszenie:${repo.toLowerCase()}#${pr}:${k.osoba}:${randomBytes(8).toString('hex')}`),
    firma: k.firma, zrodlo: 'github', typ: 'github.pr.prosba_o_review', czas: new Date().toISOString(),
    podmiot: { repo, pr, zglaszajacy: k.osoba, ...(autor ? { autor } : {}) },
    opis: `Prośba o recenzję PR #${pr} (repo ${repo}) od ${k.osoba}`,
    wymagaPracy: true,
  };
  await zapiszZdarzenie(event);
  const zadanie = await utworzZadanie(k.firma, event.id, kandydaci, { id: `zad_${event.id.slice('evt_'.length)}`, opis: event.opis });
  return { status: 200, body: { zadanie } };
}
