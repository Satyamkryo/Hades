import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../git/exec.js";
import { removeLink } from "./deps.js";
import { registerTemp } from "./temp-registry.js";

export interface RemoveWorktreeResult {
  cleanupWarning?: string;
}

const createdWorktrees = new Map<string, string>();

/** Worktrees created by this process, including those whose cleanup did not finish. */
export function trackedWorktrees(repo: string): string[] {
  const resolved = path.resolve(repo);
  return [...createdWorktrees].filter(([, owner]) => owner === resolved).map(([dir]) => dir);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Create a detached, locked worktree of `base` in the OS temp dir. Only metadata under
 * the Repo's .git/worktrees is written; the real working tree is untouched.
 * On any failure the partial worktree is removed and the original error is rethrown.
 */
export async function createWorktree(repo: string, base: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hades-summon-"));
  createdWorktrees.set(dir, path.resolve(repo));
  registerTemp(dir);
  try {
    await runGit(repo, ["worktree", "add", "--detach", dir, base]);
    // Separate command: `worktree add --reason` needs a newer git than the 2.30 minimum.
    // The lock identifies this worktree for scoped recovery and keeps cleanup metadata stable.
    await runGit(repo, ["worktree", "lock", "--reason", `hades pid=${process.pid}`, dir]);
  } catch (err) {
    await removeWorktree(repo, dir).catch(() => undefined);
    throw err;
  }
  return dir;
}

/** Remove a worktree and its folder. Never recursive-deletes through a dependency link. */
export async function removeWorktree(
  repo: string,
  dir: string,
  linkPath?: string,
): Promise<RemoveWorktreeResult> {
  const warnings: string[] = [];
  const existedAtStart = await exists(dir);

  let linkGone = true;
  if (linkPath !== undefined) {
    try {
      await removeLink(linkPath);
    } catch (e) {
      warnings.push(`could not remove dependency link ${linkPath}: ${(e as Error).message}`);
    }
    // Safety gate: only a confirmed-absent link allows the recursive delete.
    linkGone = !(await exists(linkPath));
    if (!linkGone && warnings.length === 0) {
      warnings.push(`dependency link still present at ${linkPath}`);
    }
  }

  await runGit(repo, ["worktree", "unlock", dir], { allowFail: true });
  await runGit(repo, ["worktree", "remove", "--force", dir], { allowFail: true });

  let ranRm = false;
  if (await exists(dir)) {
    if (!linkGone) {
      warnings.push(`left ${dir} in place: dependency link still present at ${linkPath}`);
    } else {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        ranRm = true;
      } catch (e) {
        warnings.push(`could not delete ${dir}: ${(e as Error).message}`);
      }
    }
  }

  // The directory can be missing or removed after the first targeted removal attempt.
  // Retry removal for this worktree alone; never prune unrelated worktree metadata.
  if (ranRm || !existedAtStart) {
    await runGit(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
  }

  return warnings.length > 0 ? { cleanupWarning: warnings.join("; ") } : {};
}
