import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { Zdarzenie, Zrodlo } from '@cognifly/wspolne';
import { klient, nazwaTabeli } from './tabela.js';

const pkHist = (firma: string) => `FIRMA#${firma}#HIST`;
const pkEvt = (firma: string) => `FIRMA#${firma}#EVT`;

/** Idempotentny zapis: znacznik EVT (attribute_not_exists) + wpis historii w jednej transakcji. */
export async function zapiszZdarzenie(z: Zdarzenie, dniRetencji = 90): Promise<'NOWE' | 'DUPLIKAT'> {
  const wygasa = Math.floor(Date.now() / 1000) + dniRetencji * 86400;
  const T = nazwaTabeli();
  try {
    await klient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: T,
              Item: { pk: pkEvt(z.firma), sk: z.id, wygasa },
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          {
            Put: {
              TableName: T,
              Item: { pk: pkHist(z.firma), sk: `${z.czas}#${z.id}`, zrodlo: z.zrodlo, typ: z.typ, zdarzenie: z, wygasa },
            },
          },
        ],
      }),
    );
    return 'NOWE';
  } catch (e) {
    if (e instanceof TransactionCanceledException) return 'DUPLIKAT';
    throw e;
  }
}

/** Zdarzenia firmy w [od, doCzasu], malejąco po czasie, maks. 200. */
export async function historia(
  firma: string,
  od: Date,
  doCzasu: Date,
  filtr?: { zrodlo?: Zrodlo; typ?: string },
): Promise<Zdarzenie[]> {
  const wartosci: Record<string, unknown> = {
    ':pk': pkHist(firma),
    ':od': od.toISOString(),
    ':do': `${doCzasu.toISOString()}~`, // '~' > znaki id: obejmuje wszystkie wpisy z czasem == doCzasu
  };
  const warunki: string[] = [];
  const nazwy: Record<string, string> = {};
  if (filtr?.zrodlo) { warunki.push('#zr = :zr'); nazwy['#zr'] = 'zrodlo'; wartosci[':zr'] = filtr.zrodlo; }
  if (filtr?.typ) { warunki.push('#ty = :ty'); nazwy['#ty'] = 'typ'; wartosci[':ty'] = filtr.typ; }

  const wynik: Zdarzenie[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await klient().send(
      new QueryCommand({
        TableName: nazwaTabeli(),
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :od AND :do',
        ...(warunki.length ? { FilterExpression: warunki.join(' AND '), ExpressionAttributeNames: nazwy } : {}),
        ExpressionAttributeValues: wartosci,
        ScanIndexForward: false,
        ExclusiveStartKey: start,
      }),
    );
    for (const it of r.Items ?? []) {
      wynik.push(it.zdarzenie as Zdarzenie);
      if (wynik.length >= 200) return wynik;
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return wynik;
}
