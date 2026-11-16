import { ZRODLA, type Zrodlo } from '@cognifly/wspolne';
import { historia } from '../dane/historia.js';
import { HttpBlad, type Kontekst, type Odpowiedz } from './kontekst.js';

const DOBA = 86_400_000;
const MAKS_PRZEDZIAL = 31 * DOBA;

function data(v: string, nazwa: string): Date {
  const d = new Date(v);
  if (v.length > 40 || Number.isNaN(d.getTime())) throw new HttpBlad(400, 'ZLY_PRZEDZIAL', { pole: nazwa });
  return d;
}

export async function zdarzenia(
  k: Kontekst,
  q: Record<string, string | undefined> = {},
  teraz: Date = new Date(),
): Promise<Odpowiedz> {
  const doCzasu = q.do ? data(q.do, 'do') : teraz;
  const od = q.od ? data(q.od, 'od') : new Date(doCzasu.getTime() - DOBA);
  if (od.getTime() > doCzasu.getTime() || doCzasu.getTime() - od.getTime() > MAKS_PRZEDZIAL) {
    throw new HttpBlad(400, 'ZLY_PRZEDZIAL');
  }
  let zrodlo: Zrodlo | undefined;
  if (q.zrodlo) {
    if (!(ZRODLA as readonly string[]).includes(q.zrodlo)) throw new HttpBlad(400, 'ZLE_ZRODLO');
    zrodlo = q.zrodlo as Zrodlo;
  }
  if (q.typ !== undefined && q.typ.length > 100) throw new HttpBlad(400, 'ZLY_TYP');
  const lista = await historia(k.firma, od, doCzasu, {
    ...(zrodlo ? { zrodlo } : {}),
    ...(q.typ ? { typ: q.typ } : {}),
  });
  return { status: 200, body: { zdarzenia: lista } };
}
