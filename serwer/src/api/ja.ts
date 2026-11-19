import type { MeResponse } from '@cognifly/wspolne/api';
import { firmyZTokenu, type Odpowiedz, type ZdarzenieApi } from './kontekst.js';

/**
 * GET /ja: kim jest zalogowana osoba — lista firm z jej identyfikatorem w każdej.
 * Nie wymaga nagłówka firmy (służy właśnie do jej wyboru).
 */
export async function ja(event: ZdarzenieApi): Promise<Odpowiedz> {
  const { firmy } = await firmyZTokenu(event);
  const body: MeResponse = {
    firmy: Object.entries(firmy).map(([firma, osoba]) => ({ firma, osoba })).sort((a, b) => a.firma.localeCompare(b.firma)),
  };
  return { status: 200, body };
}
