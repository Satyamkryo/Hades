import { runGit } from "./exec.js";

const HEX_40 = /^[0-9a-fA-F]{40}$/;
const ZERO_SHA = "0".repeat(40);

/**
 * Return the subset of `shas` that exist in the repo as commits. Exactly one
 * git call: `cat-file --batch-check` with the valid SHAs on stdin. Non-40-hex
 * strings and the all-zero SHA are rejected before the call, so they never
 * reach git; trees, blobs and missing objects are not commits.
 */
export async function existingCommits(
  repo: string,
  shas: Iterable<string>,
): Promise<Set<string>> {
  const valid = [...new Set(shas)].filter((s) => HEX_40.test(s) && s !== ZERO_SHA);
  const found = new Set<string>();
  if (valid.length === 0) {
    return found;
  }
  const result = await runGit(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: `${valid.join("\n")}\n`,
  });
  for (const line of result.stdout.split("\n")) {
    const [sha, kind] = line.trim().split(/\s+/);
    if (kind === "commit" && sha !== undefined) {
      found.add(sha);
    }
  }
  return found;
}
