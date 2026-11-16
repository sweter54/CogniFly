import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ZRODLA = ['github', 'gitlab', 'zespol', 'aws', 'poczta', 'pliki'] as const;
export type Zrodlo = (typeof ZRODLA)[number];

const schemat = z.object({
  id: z.string().regex(/^evt_[0-9a-f]{24}$/),
  firma: z.string().min(1),
  zrodlo: z.enum(ZRODLA),
  typ: z.string().min(1),
  czas: z.string().datetime(),
  podmiot: z.record(z.union([z.string(), z.number()])),
  opis: z.string().min(1).max(300),
  daneRef: z.string().optional(),
  dane: z.record(z.unknown()).optional(),
  wymagaPracy: z.boolean(),
});

export type Zdarzenie = z.infer<typeof schemat>;

export type WynikWalidacji = { ok: true; zdarzenie: Zdarzenie } | { ok: false; blad: string };

export function zwalidujZdarzenie(x: unknown): WynikWalidacji {
  const w = schemat.safeParse(x);
  if (w.success) return { ok: true, zdarzenie: w.data };
  return { ok: false, blad: w.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** Deterministyczne id — podstawa idempotencji. */
export function idZdarzenia(zrodlo: Zrodlo, kluczZewnetrzny: string): string {
  const hex = createHash('sha256').update(`${zrodlo}:${kluczZewnetrzny}`).digest('hex');
  return `evt_${hex.slice(0, 24)}`;
}
