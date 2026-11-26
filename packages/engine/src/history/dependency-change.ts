import { isDeepStrictEqual } from "node:util";
import { isDependencyFile } from "../classify/files.js";
import { runGit } from "../git/exec.js";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
] as const;

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? "";
}

/** Parsed JSON object of a blob, or null when the blob is missing, invalid or not an object. */
async function readJsonObject(
  repo: string,
  rev: string,
  p: string,
): Promise<Record<string, unknown> | null> {
  // `<rev>:<path>` is a tree path passed as one argument, so no pathspec parsing applies.
  const r = await runGit(repo, ["show", `${rev}:${p}`], { allowFail: true });
  if (r.code !== 0) return null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True when the fix changes what gets installed: any lockfile change, or a package.json whose
 * dependency fields differ between the parent and the fix. A missing side, invalid JSON or a
 * non-object package.json counts as a change.
 */
export async function changesDependencies(
  repo: string,
  sha: string,
  nonTestPaths: string[],
): Promise<boolean> {
  for (const p of nonTestPaths) {
    if (!isDependencyFile(p)) continue;
    if (baseName(p) !== "package.json") return true;
    const [before, after] = await Promise.all([
      readJsonObject(repo, `${sha}^`, p),
      readJsonObject(repo, sha, p),
    ]);
    if (before === null || after === null) return true;
    if (DEPENDENCY_FIELDS.some((f) => !isDeepStrictEqual(before[f], after[f]))) return true;
  }
  return false;
}
