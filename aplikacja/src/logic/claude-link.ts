// Builds the deep link that opens a Claude Code session for a task.
// Only the task id goes into the prompt; the CogniFly plugin fetches
// the rest itself (content from outsiders never travels in the link).
import { TASK_ID_PATTERN } from '@cognifly/wspolne/api';
import { AppError } from './errors.js';

/** Claude Desktop deep link for a new Claude Code session. */
export const CLAUDE_CODE_NEW = 'claude://code/new';

/**
 * Prompt prefilled in Claude for a task.
 *
 * Call: `taskPrompt('zad_0123456789ab')`.
 * Expects: a valid task id.
 * Output: the Polish prompt the CogniFly skill recognises.
 */
export function taskPrompt(taskId: string): string {
  return `Pracuj nad zadaniem CogniFly ${taskId}`;
}

/**
 * Builds the link that opens Claude Code on a task.
 *
 * Call: `claudeLink(taskId, workFolder)`; `workFolder` may be `''`.
 * Expects: a task id matching `TASK_ID_PATTERN`; a folder already
 * validated by the config (absolute, no `..`).
 * Output: `claude://code/new?q=<prompt>[&folder=<folder>]`, encoded.
 * Throws: `AppError('BAD_TASK_ID')` for any other id, so nothing but
 * an id can reach the prompt.
 */
export function claudeLink(taskId: string, workFolder: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new AppError('BAD_TASK_ID');
  const params = new URLSearchParams({ q: taskPrompt(taskId) });
  if (workFolder) params.set('folder', workFolder);
  return `${CLAUDE_CODE_NEW}?${params.toString().replace(/\+/g, '%20')}`;
}
