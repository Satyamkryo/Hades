import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HadesAbortError } from "../errors.js";
import { runGit } from "../git/exec.js";
import { removeLink } from "./deps.js";
import { currentProcessOwnerIdentity, hadesLockReason } from "./owner-identity.js";
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
    const identity = await currentProcessOwnerIdentity();
    await runGit(repo, ["worktree", "lock", "--reason", hadesLockReason(process.pid, identity), dir]);
  } catch (err) {
    await removeWorktree(repo, dir).catch(() => undefined);
    throw err;
  }
  return dir;
}

export interface RemoveWorktreeOptions {
  /** Abort the git waits. Filesystem waits race against it so a hang cannot block abort. */
  signal?: AbortSignal;
  /** Bound for the git and filesystem waits. Defaults to 15s. */
  timeoutMs?: number;
}

/** Default bound for one worktree removal (git unlock/remove + filesystem rm). */
export const REMOVE_WORKTREE_TIMEOUT_MS = 15_000;

function abortRace(signal?: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  if (signal === undefined) {
    return { promise: new Promise<never>(() => undefined), cleanup: () => undefined };
  }
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new HadesAbortError());
      return;
    }
    onAbort = (): void => reject(new HadesAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Prevent an unhandled rejection when the main promise wins the race.
  promise.catch(() => undefined);
  return { promise, cleanup: (): void => signal.removeEventListener("abort", onAbort) };
}

async function withBound<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const { promise: abortPromise, cleanup: cleanupAbort } = abortRace(signal);
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("removeWorktree timed out")), timeoutMs);
        })
      : new Promise<never>(() => undefined);
  // Prevent an unhandled rejection when the main promise wins the race.
  timeoutPromise.catch(() => undefined);
  try {
    return await Promise.race([promise, abortPromise, timeoutPromise]);
  } finally {
    cleanupAbort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Remove a worktree and its folder. Never recursive-deletes through a dependency link. */
export async function removeWorktree(
  repo: string,
  dir: string,
  linkPath?: string,
  opts: RemoveWorktreeOptions = {},
): Promise<RemoveWorktreeResult> {
  const warnings: string[] = [];
  const timeoutMs = opts.timeoutMs ?? REMOVE_WORKTREE_TIMEOUT_MS;
  const userSignal = opts.signal;
  if (userSignal?.aborted) throw new HadesAbortError();

  // One bound for the whole removal: git waits take a killable signal, filesystem
  // waits race against the same bound so a hang cannot block abort forever.
  const gitController = new AbortController();
  const onUserAbort = (): void => {
    gitController.abort(userSignal?.reason);
  };
  userSignal?.addEventListener("abort", onUserAbort, { once: true });
  const gitTimer = setTimeout(
    () => gitController.abort(new Error("removeWorktree timed out")),
    timeoutMs,
  );
  const gitSignal = gitController.signal;
  try {
    const existedAtStart = await withBound(exists(dir), userSignal, timeoutMs);

    let linkGone = true;
    if (linkPath !== undefined) {
      try {
        await withBound(removeLink(linkPath), userSignal, timeoutMs);
      } catch (e) {
        if ((e as Error)?.name === "HadesAbortError" && userSignal?.aborted) throw e;
        warnings.push(`could not remove dependency link ${linkPath}: ${(e as Error).message}`);
      }
      // Safety gate: only a confirmed-absent link allows the recursive delete.
      linkGone = !(await withBound(exists(linkPath), userSignal, timeoutMs));
      if (!linkGone && warnings.length === 0) {
        warnings.push(`dependency link still present at ${linkPath}`);
      }
    }

    await runGit(repo, ["worktree", "unlock", dir], { allowFail: true, signal: gitSignal });
    await runGit(repo, ["worktree", "remove", "--force", dir], { allowFail: true, signal: gitSignal });

    let ranRm = false;
    if (await withBound(exists(dir), userSignal, timeoutMs)) {
      if (!linkGone) {
        warnings.push(`left ${dir} in place: dependency link still present at ${linkPath}`);
      } else {
        try {
          await withBound(fs.rm(dir, { recursive: true, force: true }), userSignal, timeoutMs);
          ranRm = true;
        } catch (e) {
          if ((e as Error)?.name === "HadesAbortError" && userSignal?.aborted) throw e;
          warnings.push(`could not delete ${dir}: ${(e as Error).message}`);
        }
      }
    }

    // The directory can be missing or removed after the first targeted removal attempt.
    // Retry removal for this worktree alone; never prune unrelated worktree metadata.
    if (ranRm || !existedAtStart) {
      await runGit(repo, ["worktree", "remove", "--force", dir], { allowFail: true, signal: gitSignal });
    }

    if (userSignal?.aborted) throw new HadesAbortError();
    return warnings.length > 0 ? { cleanupWarning: warnings.join("; ") } : {};
  } catch (e) {
    if (userSignal?.aborted) throw new HadesAbortError();
    throw e;
  } finally {
    clearTimeout(gitTimer);
    userSignal?.removeEventListener("abort", onUserAbort);
  }
}
