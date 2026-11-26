import { runGit } from "../git/exec.js";

/**
 * Does the repo at `baseSha` have a test suite? Reads the committed package.json
 * (`git show <sha>:package.json`), not the possibly edited working copy.
 *
 * No test suite: no package.json, `scripts.test` missing / not a string / blank, or npm's
 * default `echo "Error: no test specified" && exit 1`. Invalid JSON counts as a test suite,
 * so the baseline reports the problem instead of it being silently treated as "no tests".
 */
export async function hasTestSuite(repo: string, baseSha: string): Promise<boolean> {
  const shown = await runGit(repo, ["show", `${baseSha}:package.json`], { allowFail: true });
  if (shown.code !== 0) return false;

  let pkg: unknown;
  try {
    pkg = JSON.parse(shown.stdout);
  } catch {
    return true;
  }

  const scripts = (pkg as { scripts?: unknown } | null)?.scripts;
  if (typeof scripts !== "object" || scripts === null) return false;
  const test = (scripts as { test?: unknown }).test;
  if (typeof test !== "string") return false;
  const trimmed = test.trim();
  if (trimmed === "") return false;
  return trimmed !== 'echo "Error: no test specified" && exit 1';
}
