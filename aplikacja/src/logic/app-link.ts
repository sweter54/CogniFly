// Links into the app: `cognifly://zadanie/<id>` shows a task. Any
// program can open such a link, so only this exact form is accepted,
// and it can only refresh and highlight — never change anything.
import { TASK_ID_PATTERN } from '@cognifly/wspolne/api';

/** URL scheme registered by the app (tauri.conf.json). */
export const APP_SCHEME = 'cognifly:';

/**
 * Extracts the task id from an app link.
 *
 * Call: `taskFromAppLink('cognifly://zadanie/zad_0123456789ab')`.
 * Expects: any string (links come from other programs).
 * Output: the task id, or `null` for anything else (other paths,
 * query strings, bad ids, unparsable input).
 */
export function taskFromAppLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== APP_SCHEME || url.host !== 'zadanie' || url.search || url.hash) return null;
  const id = url.pathname.replace(/^\//, '');
  return TASK_ID_PATTERN.test(id) ? id : null;
}
