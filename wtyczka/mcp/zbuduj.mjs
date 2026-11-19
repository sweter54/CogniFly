// Bundles the MCP server into one file: the installed plugin has no
// node_modules. Run: `npm run build:mcp -w wtyczka`.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/** Plugin directory; paths in the bundle are relative to it. */
const WTYCZKA = fileURLToPath(new URL('..', import.meta.url));

/** Default output, referenced by `.mcp.json`. */
export const PLIK_WYJSCIOWY = fileURLToPath(new URL('./dist/zadania.mjs', import.meta.url));

/**
 * Builds `mcp/zadania.mjs` with all packages into one ESM file.
 *
 * Call: `await zbuduj()` or `await zbuduj('/tmp/x.mjs')` (tests).
 * Expects: esbuild and the dependencies installed.
 * Output: the written file; only `node:` built-ins stay external.
 * The bundle keeps `mcp/dist/` two levels below the plugin root, as
 * `cli/lib/api.mjs` expects for `konfiguracja.json`.
 */
export async function zbuduj(plik = PLIK_WYJSCIOWY) {
  await build({
    absWorkingDir: WTYCZKA,
    entryPoints: ['mcp/zadania.mjs'],
    outfile: plik,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    logLevel: 'error',
    banner: { js: '// Generated from mcp/zadania.mjs by `npm run build:mcp -w wtyczka`. Do not edit.' },
  });
  return plik;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await zbuduj();
