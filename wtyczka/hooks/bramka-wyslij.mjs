#!/usr/bin/env node
// PreToolUse gate (Bash): publishing a code review is allowed only right
// after the human typed /cognifly:wyslij-komentarz. The model cannot
// forge a human message in the transcript, and the command has
// `disable-model-invocation`, so the model cannot send reviews itself.
// Exit 2 = block (stderr is shown to the model); exit 0 = allow.
import { readFileSync } from 'node:fs';

const COMMAND_TAG = /<command-name>\/(?:cognifly:)?wyslij-komentarz<\/command-name>/;

/**
 * Tells whether a shell command publishes a review.
 *
 * Call: `publishesReview(command)`.
 * Expects: the Bash command string.
 * Output: true for `cr.mjs … wyslij`, `gh pr review`, and `gh api`
 * writes to `…/reviews` (POST/PUT/fields/input).
 */
export function publishesReview(command) {
  const c = String(command ?? '');
  if (/cr\.mjs/.test(c) && /\bwyslij\b/.test(c)) return true;
  if (/\bgh\s+pr\s+review\b/.test(c)) return true;
  return /\bgh\s+api\b/.test(c) && /\/reviews\b/.test(c) && /(-X\s*(POST|PUT|PATCH)|--method\s+(POST|PUT|PATCH)|\s-[fF]\s|--field|--raw-field|--input)/i.test(c);
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
 * Expects: `tool_input.command` and `transcript_path`.
 * Output: exit 0 (allow) or 2 with a reason (block). Unreadable input
 * blocks only commands that publish a review (fail closed).
 */
function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* treated as no command */ }
  if (!publishesReview(input?.tool_input?.command)) process.exit(0);
  let allowed = false;
  try { allowed = lastHumanIsSendCommand(input.transcript_path); } catch { allowed = false; }
  if (allowed) process.exit(0);
  process.stderr.write('CogniFly: recenzję wysyła wyłącznie człowiek komendą /cognifly:wyslij-komentarz. '
    + 'Pokaż podsumowanie i poproś użytkownika o wpisanie tej komendy.');
  process.exit(2);
}

main();
