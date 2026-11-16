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
 * Tells whether a shell command publishes a review.
 *
 * Call: `publishesReview(command)`.
 * Expects: the Bash command string.
 * Output: true for `cr.mjs wyslij`, `gh pr review`, GraphQL review
 * mutations and `gh api` writes to `…/reviews` (POST/PUT/fields/input).
 */
export function publishesReview(command) {
  const c = String(command ?? '');
  if (/cr\.mjs["']?\s+wyslij\b/.test(c)) return true;
  if (/\bgh\s+pr\s+review\b/.test(c)) return true;
  if (/\bgh\s+api\s+graphql\b/.test(c) && /(add|submit)PullRequestReview/i.test(c)) return true;
  return /\bgh\s+api\b/.test(c) && /\/reviews\b/.test(c) && /(-X\s*(POST|PUT|PATCH)|--method\s+(POST|PUT|PATCH)|\s-[fF]\s|--field|--raw-field|--input)/i.test(c);
}

/**
 * Tells whether a tool call touches session transcripts.
 *
 * Call: `touchesTranscript(toolName, toolInput, transcriptPath)`.
 * Expects: the PreToolUse input.
 * Output: true for Bash commands mentioning the transcript path or
 * `.claude/projects`, and for file tools writing inside them.
 */
export function touchesTranscript(toolName, toolInput, transcriptPath) {
  const projects = /\.claude\/projects\b/;
  if (toolName === 'Bash') {
    const c = String(toolInput?.command ?? '');
    return projects.test(c) || (!!transcriptPath && c.includes(transcriptPath));
  }
  const file = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '');
  return !!file && (projects.test(file) || file === transcriptPath);
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
