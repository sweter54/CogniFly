import type { Kanal, Zdarzenie } from '@cognifly/wspolne';

/** PLACEHOLDER — Task 6 zastępuje tę implementację. */
export async function wyslijPowiadomienia(
  _firma: string,
  _z: Zdarzenie,
  _odbiorcy: { osoba: string; kanaly: Kanal[] }[],
  _rodzaj: 'nowe' | 'eskalacja',
): Promise<{ wyslane: number; bledy: string[] }> {
  throw new Error('nie zaimplementowano (Task 6)');
}
