#!/usr/bin/env node
import { wykonaj } from './lib/api.mjs';

try {
  const wynik = await wykonaj(process.argv.slice(2));
  process.stdout.write(JSON.stringify(wynik) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ stan: 'BLAD', kod: 'NIEOCZEKIWANY' }) + '\n');
  process.exitCode = 1;
}
