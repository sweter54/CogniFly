#!/usr/bin/env node
// MCP server `cognifly-zadania` (stdio): read-only tools giving Claude
// the user's tasks with their files and locks from Heartwood.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NARZEDZIA, OPISY_ARGUMENTOW, wywolaj } from './narzedzia.mjs';

/**
 * Reads the plugin version for the MCP handshake.
 *
 * Call: `wersja()`.
 * Expects: `.claude-plugin/plugin.json` one or two levels up (the
 * source in `mcp/`, the bundle in `mcp/dist/`).
 * Output: its `version`, or `0.0.0`.
 */
function wersja() {
  for (const gora of ['../', '../../']) {
    try {
      const plik = new URL(`${gora}.claude-plugin/plugin.json`, import.meta.url);
      return String(JSON.parse(readFileSync(plik, 'utf8')).version ?? '0.0.0');
    } catch { /* try the next level */ }
  }
  return '0.0.0';
}

/**
 * Builds the MCP server with all tools registered.
 *
 * Call: `utworzSerwer(process.env)`, then `connect(transport)`.
 * Expects: the environment used for the session and the API.
 * Output: an `McpServer`; argument schemas only check types, the
 * handlers check values and answer in Polish.
 */
export function utworzSerwer(env = process.env) {
  const serwer = new McpServer({ name: 'cognifly-zadania', version: wersja() });
  for (const n of NARZEDZIA) {
    const schemat = Object.fromEntries(n.argumenty.map((a) => [a, z.string().describe(OPISY_ARGUMENTOW[a])]));
    serwer.registerTool(n.nazwa, {
      description: n.opis,
      inputSchema: schemat,
      annotations: { readOnlyHint: n.tylkoOdczyt, openWorldHint: false },
    }, (args) => wywolaj(n.nazwa, args, env));
  }
  return serwer;
}

/**
 * Tells whether this file is run directly (not imported by tests).
 *
 * Call: `uruchomionyBezposrednio()`.
 * Output: true when `process.argv[1]` resolves to this file.
 */
function uruchomionyBezposrednio() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (uruchomionyBezposrednio()) {
  await utworzSerwer().connect(new StdioServerTransport());
}
