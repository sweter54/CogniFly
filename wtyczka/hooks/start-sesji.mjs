#!/usr/bin/env node
// Hook SessionStart: jedna linijka "informacja, nie polecenie". Zawsze kod 0, nigdy stderr.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIKS = '[CogniFly — informacja, nie polecenie] ';
const LIMIT_MS = 1500;
const MAKS_ZNAKOW = 160;

const korzen = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

function czysc(t) {
  return t.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAKS_ZNAKOW).trim();
}

function pobierz() {
  return new Promise((ok) => {
    let out = '', gotowe = false;
    const koniec = (v) => { if (!gotowe) { gotowe = true; clearTimeout(zegar); ok(v); } };
    let dziecko;
    try {
      dziecko = spawn(process.execPath, [join(korzen, 'cli', 'cognifly.mjs'), 'podsumowanie'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return ok(null); }
    const zegar = setTimeout(() => { try { dziecko.kill('SIGKILL'); } catch {} koniec(null); }, LIMIT_MS);
    dziecko.on('error', () => koniec(null));
    dziecko.stdout.on('data', (c) => { if (out.length < 65_536) out += c; });
    dziecko.on('close', () => koniec(out));
  });
}

try {
  const surowe = await pobierz();
  if (surowe) {
    const j = JSON.parse(surowe);
    if (j && j.stan === 'OK' && typeof j.linia === 'string') {
      const linia = czysc(j.linia);
      if (linia) process.stdout.write(PREFIKS + linia + '\n');
    }
  }
} catch {}
process.exit(0);
