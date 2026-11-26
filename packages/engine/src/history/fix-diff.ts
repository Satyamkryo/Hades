import { ParentUnavailableError } from "../errors.js";
import { runGit } from "../git/exec.js";

/**
 * Throw ParentUnavailableError if `<sha>^` cannot be resolved to a commit object
 * (root commit, shallow clone, missing object). Without this, git's "bad revision"
 * failure would be indistinguishable from other git errors.
 */
async function requireParent(repo: string, sha: string): Promise<void> {
  const r = await runGit(repo, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], {
    allowFail: true,
  });
  if (r.code !== 0) throw new ParentUnavailableError(sha);
  const p = await runGit(repo, ["rev-parse", "--verify", "--quiet", `${sha}^^{commit}`], {
    allowFail: true,
  });
  if (p.code !== 0) throw new ParentUnavailableError(sha);
}

/**
 * Paths changed by the fix, as raw repo-relative paths.
 * -z: NUL-separated, so spaces/unicode are never quoted.
 * --no-renames: a rename shows as delete + add, so each path is classified on its own.
 */
export async function changedFiles(repo: string, sha: string): Promise<string[]> {
  await requireParent(repo, sha);
  const { stdout } = await runGit(repo, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    `${sha}^`,
    sha,
  ]);
  return stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * The fix's patch (parent -> fix) for the given paths, in `<sha>^ <sha>` order; the
 * caller reverse-applies it with `git apply -R --3way` (decided by the spike).
 * One git call per path, with `:(literal)` so `*` or `?` in a name is not a glob.
 * --binary --full-index keep binary content and the full blob IDs that --3way needs.
 */
export async function fixPatch(repo: string, sha: string, paths: string[]): Promise<string> {
  await requireParent(repo, sha);
  const parts: string[] = [];
  for (const p of paths) {
    const { stdout } = await runGit(repo, [
      "diff",
      "--no-color",
      "--no-textconv",
      "--binary",
      "--full-index",
      "--no-renames",
      `${sha}^`,
      sha,
      "--",
      `:(literal)${p}`,
    ]);
    if (stdout.length > 0) parts.push(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  return parts.join("");
}

/** `--stat` plus the start of the patch, cut to maxChars, for the LLM prompt. */
export async function diffSummary(repo: string, sha: string, maxChars = 6000): Promise<string> {
  await requireParent(repo, sha);
  const { stdout } = await runGit(repo, ["diff", "--stat", "--patch", "--no-renames", `${sha}^`, sha]);
  return stdout.length > maxChars ? stdout.slice(0, maxChars) : stdout;
}
