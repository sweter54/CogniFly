import type { Zdarzenie } from '@cognifly/wspolne';

/** Pola, z których wolno budować powiadomienie: `opis` (budowany przez serwer) i pola strukturalne. Nigdy `dane`/`daneRef`. */
export type DoFormatu = Pick<Zdarzenie, 'opis'> & Partial<Pick<Zdarzenie, 'zrodlo' | 'typ' | 'podmiot'>>;

export interface Wiadomosc {
  temat: string;
  tekst: string;
  discord: object;
}

const ZWSP = '​';
/** Dodatkowa ochrona obok `allowed_mentions.parse: []`. */
const bezWzmianek = (s: string) => s.replace(/@(everyone|here)/gi, `@${ZWSP}$1`);
/**
 * Cuts text to a maximum length in code points.
 *
 * Call: `przytnij(s, 120)`.
 * Expects: any string and a max length >= 1.
 * Output: `s` unchanged when short enough, else its first `max - 1`
 * code points followed by `…` (exactly `max` code points; a
 * surrogate pair is never split).
 */
export const przytnij = (s: string, max: number) => {
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
};

export function formatuj(z: DoFormatu, rodzaj: 'nowe' | 'eskalacja', link?: string): Wiadomosc {
  const prefiks = rodzaj === 'eskalacja' ? '[CogniFly] Eskalacja: ' : '[CogniFly] ';
  const opis = z.opis;
  const temat = przytnij(`${prefiks}${opis}`.replace(/[\r\n]+/g, ' '), 200);

  const pola: string[] = [];
  if (z.zrodlo) pola.push(`Źródło: ${z.zrodlo}`);
  if (z.typ) pola.push(`Typ: ${z.typ}`);
  const p = z.podmiot ?? {};
  if (p.repo !== undefined) pola.push(`Repozytorium: ${p.repo}`);
  if (p.pr !== undefined) pola.push(`PR: #${p.pr}`);

  const tekst = [rodzaj === 'eskalacja' ? 'Zadanie nadal nie zostało wzięte.' : null, opis, ...pola, link ?? null]
    .filter((x): x is string => x !== null)
    .join('\n');

  const discord = {
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: przytnij(bezWzmianek(rodzaj === 'eskalacja' ? 'Eskalacja' : 'Nowe zdarzenie'), 256),
        description: przytnij(bezWzmianek([opis, ...pola, ...(link ? [link] : [])].join('\n')), 4096),
        color: rodzaj === 'eskalacja' ? 0xd9534f : 0x5bc0de,
      },
    ],
  };
  return { temat, tekst, discord };
}
