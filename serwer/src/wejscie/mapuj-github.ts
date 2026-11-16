import { idZdarzenia, zwalidujZdarzenie, type Zdarzenie } from '@cognifly/wspolne';

/**
 * Mapowanie zdarzeń GitHuba na zdarzenia CogniFly.
 * `opis` powstaje WYŁĄCZNIE z szablonu + repo (full_name) + numeru PR + loginu.
 * Tytuły, treści commitów, nazwy gałęzi i URL-e trafiają do `dane`.
 * Reguła v1: każdy `pull_request.synchronize` => `github.pr.commit_po_review`
 * (payload nie niesie liczby recenzji; o tym, kogo to obchodzi, decydują reguły).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapujGithub(nazwaZdarzenia: string, idDostawy: string, payload: any, firma: string): Zdarzenie | null {
  const repo: unknown = payload?.repository?.full_name;
  if (typeof repo !== 'string' || !repo) return null;
  const pr = payload?.pull_request;
  const numer: unknown = pr?.number ?? payload?.number;
  const autor: string = String(pr?.user?.login ?? payload?.sender?.login ?? 'nieznany');

  let typ: string;
  let opis: string;
  let wymagaPracy: boolean;
  let podmiot: Record<string, string | number>;
  let dane: Record<string, unknown>;

  if (nazwaZdarzenia === 'push') {
    const galaz = String(payload.ref ?? '').replace(/^refs\/heads\//, '');
    const pushujacy = String(payload.pusher?.name ?? payload.sender?.login ?? 'nieznany');
    typ = 'github.push';
    opis = `Nowy push w repo ${repo} od ${pushujacy}`;
    wymagaPracy = false;
    podmiot = { repo, autor: pushujacy };
    if (galaz) podmiot.galaz = galaz;
    dane = { commit: payload.head_commit?.id, wiadomosc: payload.head_commit?.message, url: payload.head_commit?.url };
  } else if (nazwaZdarzenia === 'pull_request' && typeof numer === 'number') {
    const daneWspolne = { tytul: pr?.title, url: pr?.html_url };
    const galaz = pr?.head?.ref;
    const baza: Record<string, string | number> = { repo, pr: numer, autor };
    if (typeof galaz === 'string' && galaz) baza.galaz = galaz;
    if (payload.action === 'synchronize') {
      typ = 'github.pr.commit_po_review';
      opis = `Nowy commit w PR #${numer} (repo ${repo}) po recenzji`;
      wymagaPracy = true;
      podmiot = baza;
      dane = daneWspolne;
    } else if (payload.action === 'review_requested') {
      const rec = payload.requested_reviewer?.login;
      typ = 'github.pr.prosba_o_review';
      opis = `Prośba o recenzję PR #${numer} (repo ${repo})${typeof rec === 'string' ? ` dla ${rec}` : ''}`;
      wymagaPracy = true;
      podmiot = typeof rec === 'string' ? { ...baza, recenzent: rec } : baza;
      dane = daneWspolne;
    } else return null;
  } else if (nazwaZdarzenia === 'pull_request_review' && payload.action === 'submitted' && typeof numer === 'number') {
    const rec = String(payload.review?.user?.login ?? payload.sender?.login ?? 'nieznany');
    const galaz = pr?.head?.ref;
    typ = 'github.pr.review';
    opis = `Nowa recenzja PR #${numer} (repo ${repo}) od ${rec}`;
    wymagaPracy = true;
    podmiot = { repo, pr: numer, autor, recenzent: rec };
    if (typeof galaz === 'string' && galaz) podmiot.galaz = galaz;
    dane = { tytul: pr?.title, url: pr?.html_url, stan: payload.review?.state, recenzjaUrl: payload.review?.html_url };
  } else return null;

  const wynik = zwalidujZdarzenie({
    id: idZdarzenia('github', idDostawy),
    firma,
    zrodlo: 'github',
    typ,
    czas: new Date().toISOString(),
    podmiot,
    opis,
    dane,
    wymagaPracy,
  });
  return wynik.ok ? wynik.zdarzenie : null;
}
