#!/usr/bin/env node
// PreToolUse gate: publishing a code review is allowed only right after
// the human typed /cognifly:wyslij-komentarz (the command has
// `disable-model-invocation`). The gate reads the session transcript,
// so it also blocks the model from writing to transcripts (Bash or file
// tools) — otherwise it could append a fake human message.
// Exit 2 = block (stderr is shown to the model); exit 0 = allow.
import { readFileSync } from 'node:fs';

const COMMAND_TAG = /<command-name>\/(?:cognifly:)?wyslij-komentarz<\/command-name>/;

/**
 * Where a shell command can start: line start, after ; & | ( $( ` or a
 * quote (bash -c '…'), optionally behind wrappers (`env`, `command`, `exec`,
 * `nohup`, `time`, with their flags) and variable assignments (`A=1`).
 */
const START = String.raw`(?:^|[\n;&|(\x60]|\$\(|['"])\s*(?:(?:env|command|exec|nohup|time)\b(?:\s+-\S+)*\s+)*(?:\w+=\S*\s+)*`;
/**
 * `cr.mjs wyslij` anywhere in the command: the path may be quoted and
 * contain spaces ("~/Library/Application Support/…/cr.mjs") or sit behind
 * any prefix. Fail closed: a literal "cr.mjs wyslij" elsewhere also blocks.
 */
const SEND_SCRIPT = /cr\.mjs["']?\s+["']?wyslij\b/;
/** `"$VAR" wyslij` — the script path kept in a variable (checked only when the command names cr.mjs). */
const SEND_VIA_VAR = /\$\{?\w+\}?["']?\s+["']?wyslij\b/;
const PR_REVIEW = new RegExp(`${START}(?:\\S*/)?gh\\s+pr\\s+review\\b`);
const GH_API = new RegExp(`${START}(?:\\S*/)?gh\\s+api\\b`);
const WRITE_FLAGS = /(-X\s*(POST|PUT|PATCH)|--method\s+(POST|PUT|PATCH)|\s-[fF]\s|--field|--raw-field|--input)/i;

/**
 * Removes the bodies of `cat … <<EOF` heredocs (text written to a file,
 * e.g. a PR description); heredocs fed to shells are kept.
 *
 * Call: `withoutWrittenText(command)`.
 * Expects: a Bash command string.
 * Output: the command with those heredoc bodies removed.
 */
function withoutWrittenText(command) {
  return command.replace(/\bcat\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g, 'cat');
}

/**
 * Empties quoted values of the cr.mjs text flags (`--tresc`,
 * `--podsumowanie`), so a review comment that quotes a send command does
 * not block `dodaj`/`omow`/`werdykt`. Double-quoted values with `$(` or
 * a backtick are kept: the shell runs those substitutions (fail closed).
 *
 * Call: `withoutTextFlags(command)`.
 * Expects: a Bash command string.
 * Output: the command with those quoted values replaced by "".
 */
function withoutTextFlags(command) {
  return command.replace(/(--(?:tresc|podsumowanie)(?:=|\s+))("(?:[^"\\]|\\.)*"|'[^']*')/g,
    (whole, flag, value) => (value.startsWith('"') && /\$\(|`/.test(value) ? whole : `${flag}""`));
}

/**
 * Whether a Bash command stays inside auto-memory when it names the
 * Claude projects directory: every such path points into
 * `<projekt>/memory` (or below) and the command has no `..` segment.
 *
 * Call: `onlyMemory(command)`.
 * Expects: a Bash command string that names `.claude/projects`.
 * Output: true only when the command cannot reach a transcript that way.
 */
function onlyMemory(command) {
  if (/(?:^|[\s/'"=])\.\.(?=$|[\s/'";&|)])/.test(command)) return false;
  const paths = command.match(/\.claude\/projects\b[^\s'";&|)]*/g) ?? [];
  return paths.every((p) => /^\.claude\/projects\/[^/*?[\]]+\/memory(?:\/|$)/.test(p));
}

/**
 * Tells whether a shell command publishes a review.
 *
 * Call: `publishesReview(command)`.
 * Expects: the Bash command string.
 * Output: true for `cr.mjs wyslij` (anywhere, also via a path in a
 * variable), and — at a command position — `gh pr review`, a GraphQL
 * review mutation or a `gh api` write to `…/reviews`. Text written to
 * files via `cat <<EOF`, values of `--tresc`/`--podsumowanie` and words
 * inside messages (e.g. commit messages) do not count.
 */
export function publishesReview(command) {
  const c = withoutTextFlags(withoutWrittenText(String(command ?? '')));
  if (SEND_SCRIPT.test(c) || PR_REVIEW.test(c)) return true;
  if (/cr\.mjs/.test(c) && SEND_VIA_VAR.test(c)) return true;
  if (!GH_API.test(c)) return false;
  if (/\bgraphql\b/.test(c) && /(add|submit)PullRequestReview/i.test(c)) return true;
  return /\/reviews\b/.test(c) && WRITE_FLAGS.test(c);
}

/**
 * Tells whether a tool call touches session transcripts.
 *
 * Call: `touchesTranscript(toolName, toolInput, transcriptPath)`.
 * Expects: the PreToolUse input.
 * Output: true for file tools writing a `*.jsonl` file in the Claude
 * projects directory (or the transcript itself), and for Bash commands
 * naming the transcript path, or naming that directory together with
 * "jsonl", with a `..` segment or with any path outside a `memory` folder. Auto-memory
 * (`<projekt>/memory/*.md`) stays usable; `--tresc`/`--podsumowanie`
 * values are ignored.
 */
export function touchesTranscript(toolName, toolInput, transcriptPath) {
  const transcripts = /\.claude\/projects\/[^\s'";&|]*\.jsonl\b/;
  if (toolName === 'Bash') {
    const c = withoutTextFlags(String(toolInput?.command ?? ''));
    if (!!transcriptPath && c.includes(transcriptPath)) return true;
    if (!/\.claude\/projects\b/.test(c)) return false;
    return /jsonl/i.test(c) || !onlyMemory(c);
  }
  const file = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '');
  return !!file && (transcripts.test(file) || file === transcriptPath);
}

/**
 * Text of a user transcript entry, or null for tool results/meta.
 *
 * Call: `humanText(entry)`.
 * Expects: one parsed JSONL transcript entry.
 * Output: the text the human typed (or the command marker), null when
 * the entry is not a human message.
 */
function humanText(entry) {
  if (entry?.type !== 'user' || entry.isMeta) return null;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.every((p) => p?.type === 'tool_result')) return null;
  return content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

/**
 * Whether the latest human message is the send command.
 *
 * Call: `lastHumanIsSendCommand(transcriptPath)`.
 * Expects: the session transcript (JSONL).
 * Output: true only when the newest human message contains the
 * /cognifly:wyslij-komentarz command marker.
 * Throws: when the transcript cannot be read (caller blocks).
 */
function lastHumanIsSendCommand(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const text = humanText(entry);
    if (text !== null) return COMMAND_TAG.test(text);
  }
  return false;
}

/**
 * Hook entry.
 *
 * Call: by Claude Code with the PreToolUse JSON on stdin.
 * Expects: `tool_name`, `tool_input` and `transcript_path`.
 * Output: exit 0 (allow) or 2 with a reason (block). Transcript access
 * is always blocked; publishing a review only without the command.
 * Unreadable transcript blocks publishing (fail closed).
 */
function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* treated as no command */ }
  if (touchesTranscript(input?.tool_name, input?.tool_input, input?.transcript_path)) {
    process.stderr.write('CogniFly: zapis i odczyt transkrypcji sesji są zablokowane (chroni bramkę wysyłania recenzji).');
    process.exit(2);
  }
  if ((input?.tool_name ?? 'Bash') !== 'Bash' || !publishesReview(input?.tool_input?.command)) process.exit(0);
  let allowed = false;
  try { allowed = lastHumanIsSendCommand(input.transcript_path); } catch { allowed = false; }
  if (allowed) process.exit(0);
  process.stderr.write('CogniFly: recenzję wysyła wyłącznie człowiek komendą /cognifly:wyslij-komentarz. '
    + 'Pokaż podsumowanie i poproś użytkownika o wpisanie tej komendy.');
  process.exit(2);
}

main();
