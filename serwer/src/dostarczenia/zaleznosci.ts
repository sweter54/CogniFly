// Dependencies between deliveries (pull requests): explicit "Zależy od:"
// lines in the PR description and PRs stacked on another PR's branch.

/** A pull request in a repository (`owner/name`). */
export interface PrRef { repo: string; number: number }

const LINE = /^\s*(?:zależy od|zalezy od|depends on)\s*:(.*)$/gimu;
const ITEM = /(?:^|[\s,;(])((?:[A-Za-z0-9][\w.-]*\/[\w.-]+)?)#(\d{1,7})\b/g;
const REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.-]+$/;

/**
 * Checks an `owner/name` repository string.
 *
 * Call: `isRepo('o/r')`.
 * Expects: any string.
 * Output: true for GitHub-like `owner/name` without `..` segments.
 */
export function isRepo(repo: string): boolean {
  return REPO.test(repo) && !repo.split('/').includes('..');
}

/**
 * Stable key of a PR reference.
 *
 * Call: `refKey({ repo: 'o/r', number: 12 })`.
 * Expects: a reference.
 * Output: `o/r#12` with the repo lowercased (GitHub is case-blind).
 */
export function refKey(ref: PrRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}

/**
 * Reads explicit dependencies from a PR description.
 *
 * Call: `parseDependsOn(body, self)`.
 * Expects: the description (any text, may be null) and the PR itself.
 * Output: unique references from lines `Zależy od:` / `Depends on:`
 * (`#12` = same repo, `owner/repo#34` = other repo), in order of
 * appearance; the PR itself, `#0` and malformed repos are skipped.
 */
export function parseDependsOn(body: string | null | undefined, self: PrRef): PrRef[] {
  const found = new Map<string, PrRef>();
  for (const line of (body ?? '').matchAll(LINE)) {
    for (const m of (line[1] ?? '').matchAll(ITEM)) {
      const repo = m[1] || self.repo;
      const number = Number(m[2]);
      if (number < 1 || !isRepo(repo)) continue;
      const ref = { repo, number };
      if (refKey(ref) !== refKey(self) && !found.has(refKey(ref))) found.set(refKey(ref), ref);
    }
  }
  return [...found.values()];
}

/**
 * Finds the PR this one is stacked on.
 *
 * Call: `stackedOn(repo, baseRef, openPrs)`.
 * Expects: this PR's repo and base branch; the repo's open PRs with
 * their head branches.
 * Output: the open PR whose head branch is this PR's base, or null.
 */
export function stackedOn(repo: string, baseRef: string, openPrs: readonly { number: number; headRef: string }[]): PrRef | null {
  const parent = openPrs.find((p) => p.headRef === baseRef);
  return parent ? { repo, number: parent.number } : null;
}
