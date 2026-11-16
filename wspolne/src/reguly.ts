import type { Zrodlo } from './zdarzenie.js';

export type Kanal = 'email' | 'discord' | 'claude';

export interface Regula {
  id: string;
  firma: string;
  gdy: { zrodlo: Zrodlo; typ?: string; podmiot?: Record<string, string | number> };
  powiadom: { osoby?: string[]; role?: string[]; kanaly: Kanal[] };
  przydziel?: { osoby?: string[]; role?: string[] };
  eskalacjaMin?: number;
  eskalujDo?: { osoby?: string[]; kanaly: Kanal[] };
  auto?: boolean;
}

export interface Decyzja {
  powiadom: { osoba: string; kanaly: Kanal[] }[];
  kandydaci: string[];
  eskalacjaMin: number | null;
  eskalujDo: { osoba: string; kanaly: Kanal[] }[];
  auto: boolean;
}
