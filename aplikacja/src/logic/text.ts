// Small pure text helpers shared by the windows and the tray: Polish
// plural forms and shortening of long paths and titles.

/** Mark of text that was shortened. */
const ELLIPSIS = '…';

/**
 * Polish plural form for a count.
 *
 * Call: `plural(n, 'zapis', 'zapisy', 'zapisów')`.
 * Expects: an integer ≥ 0 and the three forms.
 * Output: `one` for 1, `few` for 2–4 (not 12–14) in the last
 * digits, else `many`.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const tens = n % 100;
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/**
 * Shortens a path to its end, so the file name stays visible.
 *
 * Call: `shortPath(fullPath, 40)`; show the full path in `title`.
 * Expects: any `/`-separated path (a trailing `/` marks a folder)
 * and the most characters to show.
 * Output: the path when it fits; else `…/` plus as many whole last
 * segments as fit; `…name` or `name` when only the name fits; a
 * name longer than the limit becomes `…` plus its tail. A limit
 * below 2 gives `…`.
 */
export function shortPath(path: string, maxChars: number): string {
  if (Array.from(path).length <= maxChars) return path;
  if (maxChars < 2) return ELLIPSIS;
  const { parents, name } = splitName(path);
  const fit = (s: string) => Array.from(s).length <= maxChars;
  if (!fit(`${ELLIPSIS}/${name}`)) return nameOnly(name, maxChars);
  let kept = name;
  for (const segment of [...parents].reverse()) {
    if (!fit(`${ELLIPSIS}/${segment}/${kept}`)) break;
    kept = `${segment}/${kept}`;
  }
  return `${ELLIPSIS}/${kept}`;
}

/**
 * Splits a path into its parent segments and its last name.
 *
 * Call: `splitName('/a/b/c.txt')`.
 * Expects: any path; a trailing `/` stays with the name.
 * Output: non-empty parent segments and the name (`c.txt`, or
 * `folder/` for `…/folder/`).
 */
function splitName(path: string): { parents: string[]; name: string } {
  const slash = path.endsWith('/') ? '/' : '';
  const segments = path.split('/').filter((s) => s !== '');
  const name = `${segments.pop() ?? ''}${slash}`;
  return { parents: segments, name };
}

/**
 * A path shortened to its name alone.
 *
 * Call: `nameOnly(name, max)` when `…/name` does not fit.
 * Expects: the last name of a path and a limit ≥ 2.
 * Output: `…name` when it fits, else `name` when it fits, else
 * `…` plus the name's tail.
 */
function nameOnly(name: string, maxChars: number): string {
  const length = Array.from(name).length;
  if (length < maxChars) return `${ELLIPSIS}${name}`;
  return length === maxChars ? name : tail(name, maxChars);
}

/**
 * The end of a text that is too long.
 *
 * Call: `tail(name, 10)`.
 * Expects: a text longer than `maxChars` and a limit ≥ 2.
 * Output: `…` plus the last `maxChars - 1` characters.
 */
function tail(text: string, maxChars: number): string {
  return `${ELLIPSIS}${Array.from(text).slice(-(maxChars - 1)).join('')}`;
}

/**
 * Cuts a one-line text to a length, keeping its start.
 *
 * Call: `clip(title, 40)`.
 * Expects: a one-line text and a limit ≥ 1.
 * Output: the text when it fits; else its start (trailing spaces
 * dropped) plus `…`, at most `maxChars` characters.
 */
export function clip(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}${ELLIPSIS}`;
}
