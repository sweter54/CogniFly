import type { Decyzja, Kanal, Regula, Zdarzenie } from '@cognifly/wspolne';

export const DOMYSLNA_ESKALACJA_MIN = 15;

function typPasuje(wzorzec: string | undefined, typ: string): boolean {
  if (wzorzec === undefined) return true;
  if (wzorzec.endsWith('*')) return typ.startsWith(wzorzec.slice(0, -1));
  return wzorzec === typ;
}

function pasuje(r: Regula, z: Zdarzenie): boolean {
  if (r.firma !== z.firma || r.gdy.zrodlo !== z.zrodlo) return false;
  if (!typPasuje(r.gdy.typ, z.typ)) return false;
  for (const [k, v] of Object.entries(r.gdy.podmiot ?? {})) {
    if (z.podmiot[k] !== v) return false;
  }
  return true;
}

function osoby(o: { osoby?: string[]; role?: string[] } | undefined, role: Record<string, string[]>): string[] {
  if (!o) return [];
  return [...(o.osoby ?? []), ...(o.role ?? []).flatMap((r) => Object.hasOwn(role, r) ? role[r]! : [])];
}

function dodaj(m: Map<string, Kanal[]>, osoba: string, kanaly: Kanal[]): void {
  const k = m.get(osoba) ?? [];
  for (const c of kanaly) if (!k.includes(c)) k.push(c);
  m.set(osoba, k);
}

const wBlok = (m: Map<string, Kanal[]>) => [...m].map(([osoba, kanaly]) => ({ osoba, kanaly }));

/** Czysta funkcja: łączy wszystkie pasujące reguły tej firmy w jedną decyzję. */
export function rozstrzygnij(z: Zdarzenie, reguly: Regula[], role: Record<string, string[]>): Decyzja {
  const pasujace = reguly.filter((r) => pasuje(r, z));
  const powiadom = new Map<string, Kanal[]>();
  const eskalujDo = new Map<string, Kanal[]>();
  const kandydaci = new Set<string>();
  const zPrzydzialem = pasujace.filter((r) => r.przydziel);

  for (const r of pasujace) {
    for (const o of osoby(r.powiadom, role)) dodaj(powiadom, o, r.powiadom.kanaly);
    for (const o of osoby(r.przydziel, role)) kandydaci.add(o);
    for (const o of osoby(r.eskalujDo, role)) dodaj(eskalujDo, o, r.eskalujDo?.kanaly ?? []);
  }

  return {
    powiadom: wBlok(powiadom),
    kandydaci: [...kandydaci],
    eskalacjaMin: zPrzydzialem.length
      ? Math.min(...zPrzydzialem.map((r) => r.eskalacjaMin ?? DOMYSLNA_ESKALACJA_MIN))
      : null,
    eskalujDo: wBlok(eskalujDo),
    auto: zPrzydzialem.length > 0 && zPrzydzialem.every((r) => r.auto === true),
  };
}
