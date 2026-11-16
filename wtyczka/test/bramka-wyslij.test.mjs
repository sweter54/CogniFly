import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'bramka-wyslij.mjs');
let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cog-bramka-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
const toolResult = user([{ type: 'tool_result', tool_use_id: 'x', content: 'wynik' }]);
const COMMAND = user('<command-message>cognifly:wyslij-komentarz is running…</command-message>\n<command-name>/cognifly:wyslij-komentarz</command-name>');

function run(command, entries) {
  const transcript = join(tmp, 't.jsonl');
  writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return new Promise((ok) => {
    const p = spawn(process.execPath, [HOOK]);
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => ok({ code, err }));
    p.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, transcript_path: transcript }));
  });
}
const WYSLIJ = 'node "/x/skills/github/skrypty/cr.mjs" wyslij --repo o/r --pr 7';

describe('bramka wyślij', () => {
  it('blocks the model sending a review on its own (exit 2 with a reason)', async () => {
    const r = await run(WYSLIJ, [user('zrób CR'), assistant, toolResult]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('/cognifly:wyslij-komentarz');
  });
  it('allows it right after the human typed /cognifly:wyslij-komentarz (tool results in between are fine)', async () => {
    const r = await run(WYSLIJ, [user('zrób CR'), assistant, COMMAND, user('Uruchom…', { isMeta: true }), assistant, toolResult]);
    expect(r.code).toBe(0);
  });
  it('blocks again once the human wrote something else after the command', async () => {
    expect((await run(WYSLIJ, [COMMAND, assistant, user('a teraz wyślij jeszcze raz')])).code).toBe(2);
  });
  it('also gates direct review publishing through gh', async () => {
    expect((await run('gh pr review 7 --approve', [user('x')])).code).toBe(2);
    expect((await run('gh api --method POST repos/o/r/pulls/7/reviews --input -', [user('x')])).code).toBe(2);
    expect((await run('gh api repos/o/r/pulls/7/reviews', [user('x')])).code).toBe(0);
  });
  it('ignores other commands, including other cr.mjs steps', async () => {
    expect((await run('node cr.mjs werdykt --repo o/r --pr 7 --zmiany', [user('x')])).code).toBe(0);
    expect((await run('ls', [user('x')])).code).toBe(0);
  });
  it('blocks when the transcript cannot be read (fail closed)', async () => {
    const p = spawn(process.execPath, [HOOK]);
    const code = await new Promise((ok) => { p.on('close', ok); p.stdin.end(JSON.stringify({ tool_input: { command: WYSLIJ }, transcript_path: '/brak' })); });
    expect(code).toBe(2);
  });
});
