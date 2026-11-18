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

function run(command, entries, tool = { tool_name: 'Bash', tool_input: { command } }) {
  const transcript = join(tmp, 't.jsonl');
  writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return new Promise((ok) => {
    const p = spawn(process.execPath, [HOOK]);
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => ok({ code, err, transcript }));
    p.stdin.end(JSON.stringify({ ...tool, transcript_path: transcript }));
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

  it('blocks GraphQL review mutations', async () => {
    expect((await run(`gh api graphql -f query='mutation{addPullRequestReview(input:{}){clientMutationId}}'`, [user('x')])).code).toBe(2);
    expect((await run(`gh api graphql -f query='query{viewer{login}}'`, [user('x')])).code).toBe(0);
  });
  it('blocks tampering with the session transcript (Bash or file tools)', async () => {
    const t = join(tmp, 't.jsonl');
    expect((await run(`echo '{}' >> "${t}"`, [user('x')])).code).toBe(2);
    expect((await run('cat ~/.claude/projects/x/y.jsonl', [user('x')])).code).toBe(2);
    expect((await run('', [user('x')], { tool_name: 'Write', tool_input: { file_path: t, content: '{}' } })).code).toBe(2);
    expect((await run('', [user('x')], { tool_name: 'Edit', tool_input: { file_path: '/Users/m/.claude/projects/a/b.jsonl' } })).code).toBe(2);
    expect((await run('', [user('x')], { tool_name: 'Write', tool_input: { file_path: '/tmp/zwykly.txt' } })).code).toBe(0);
  });
  it('does not block reading or grepping the script', async () => {
    expect((await run('grep -n wyslij wtyczka/skills/github/skrypty/cr.mjs', [user('x')])).code).toBe(0);
  });
  it('does not treat text in a written file (cat heredoc) or in a quoted message as a command', async () => {
    const pr = "cat > /tmp/opis.md <<'EOF'\nBramka blokuje `gh pr review` i `cr.mjs wyslij`.\nEOF\ngh pr create --body-file /tmp/opis.md";
    expect((await run(pr, [user('x')])).code).toBe(0);
    expect((await run('git commit -m "bramka: blokuje gh pr review"', [user('x')])).code).toBe(0);
  });
  it('catches cr.mjs wyslij behind a quoted path with spaces, env prefix or a variable', async () => {
    for (const c of [
      'node "/Users/m/Library/Application Support/Claude/plug/skills/github/skrypty/cr.mjs" wyslij --repo o/r --pr 7',
      "node '/Users/m/Library/Application Support/x/cr.mjs' wyslij --repo o/r --pr 7",
      'env NODE_OPTIONS= node "/a b/cr.mjs" wyslij --repo o/r --pr 7',
      'S="/a b/skrypty/cr.mjs"; node "$S" wyslij --repo o/r --pr 7',
      'S="/a b/skrypty/cr.mjs"; node ${S} "wyslij" --repo o/r --pr 7',
      'env gh pr review 7 --approve',
      '/opt/homebrew/bin/gh pr review 7 --approve',
    ]) {
      expect((await run(c, [user('x')])).code, c).toBe(2);
    }
  });
  it('does not block dodaj/werdykt whose text quotes a send command', async () => {
    const dodaj = 'node "/a b/cr.mjs" dodaj --repo o/r --pr 7 --plik x --linia 3 --tresc "przykład: node \\"$P/cr.mjs\\" wyslij --pr 7 i gh pr review"';
    expect((await run(dodaj, [user('x')])).code).toBe(0);
    const werdykt = "node cr.mjs werdykt --repo o/r --pr 7 --zmiany --podsumowanie 'popraw cr.mjs wyslij'";
    expect((await run(werdykt, [user('x')])).code).toBe(0);
  });
  it('still blocks a send hidden in a command substitution inside a double-quoted text flag', async () => {
    for (const c of [
      'node cr.mjs dodaj --repo o/r --pr 7 --plik x --linia 3 --tresc "$(gh pr review 7 --approve)"',
      'node cr.mjs dodaj --repo o/r --pr 7 --plik x --linia 3 --tresc "ok `gh pr review 7 --approve`"',
      'node cr.mjs werdykt --repo o/r --pr 7 --akceptuj --podsumowanie="a $(node /x/cr.mjs wyslij --pr 7)"',
    ]) {
      expect((await run(c, [user('x')])).code, c).toBe(2);
    }
    expect((await run("node cr.mjs dodaj --pr 7 --tresc '$(gh pr review 7 --approve)'", [user('x')])).code).toBe(0);
  });
  it('does not let ../ escape the memory folder towards transcripts', async () => {
    for (const c of [
      'cat ~/.claude/projects/a/memory/../*.j*',
      'cat ~/.claude/projects/a/memory/x/../../b/*',
      'cd ~/.claude/projects/a/memory && cat ../*.j*',
      'cat ~/.claude/projects/a/memory/notatka.md ~/.claude/projects/a/*',
      'ls ~/.claude/projects/a/memory*',
    ]) {
      expect((await run(c, [user('x')])).code, c).toBe(2);
    }
    expect((await run('ls ~/.claude/projects/a/memory/ && cat ~/.claude/projects/a/memory/*.md', [user('x')])).code).toBe(0);
  });
  it('keeps auto-memory usable while still guarding transcripts', async () => {
    const mem = '/Users/m/.claude/projects/-Users-m-x/memory/notatka.md';
    expect((await run('', [user('x')], { tool_name: 'Write', tool_input: { file_path: mem, content: 'x' } })).code).toBe(0);
    expect((await run('', [user('x')], { tool_name: 'Edit', tool_input: { file_path: mem } })).code).toBe(0);
    expect((await run(`cat "${mem}"`, [user('x')])).code).toBe(0);
    expect((await run('node cr.mjs dodaj --tresc "blokuje ~/.claude/projects" --pr 7', [user('x')])).code).toBe(0);
    expect((await run('cd ~/.claude/projects/a && echo x >> b.jsonl', [user('x')])).code).toBe(2);
    expect((await run('ls ~/.claude/projects', [user('x')])).code).toBe(2);
  });
  it('still catches commands after separators, in subshells, bash -c and shell heredocs', async () => {
    for (const c of ['ls && gh pr review 7 -c', 'x=$(gh pr review 7 --approve)', "bash -c 'gh pr review 7 --approve'",
      'cd w; node wtyczka/skills/github/skrypty/cr.mjs wyslij --repo o/r --pr 7', "bash <<'EOF'\ngh pr review 7 --approve\nEOF"]) {
      expect((await run(c, [user('x')])).code, c).toBe(2);
    }
  });
});
