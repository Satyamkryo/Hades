import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedOptions } from "../config.js";
import { runGit } from "../git/exec.js";
import type { DepsPlan } from "./deps-plan.js";
import { setupDeps } from "./deps.js";
import { runCommand } from "./process.js";
import { createWorktree, removeWorktree } from "./worktree.js";

export type BaselineOptions = Pick<
  ResolvedOptions,
  "testCommand" | "timeoutMs" | "installCommand" | "installTimeoutMs" | "excerptChars"
>;

export type BaselineResult = (
  | { passed: true; excerpt: string }
  | { passed: false; reason: string; excerpt: string }
) & {
  worktreePath?: string;
  cleanupWarning?: string;
  cleanupError?: string;
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Hints explaining why a baseline may fail only inside the summoning worktree. */
export async function baselineHints(repo: string): Promise<string[]> {
  const hints: string[] = [];

  if (await exists(path.join(repo, ".gitmodules"))) {
    hints.push("repo uses submodules, which are not initialised in the summoning worktree");
  }

  try {
    const attrs = await fs.readFile(path.join(repo, ".gitattributes"), "utf8");
    if (attrs.includes("filter=lfs")) {
      hints.push("repo uses Git LFS; LFS files may be pointers in the summoning worktree");
    }
  } catch {
    // No .gitattributes.
  }

  // --others --ignored lists untracked files matched by .gitignore; the worktree has none of them.
  const ignored = await runGit(
    repo,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ".env*"],
    { allowFail: true },
  );
  if (ignored.code === 0 && ignored.stdout.trim() !== "") {
    hints.push("repo has gitignored .env files, which are not copied into the summoning worktree");
  }

  return hints;
}

async function isLink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function withHints(repo: string, failure: string): Promise<string> {
  const hints = await baselineHints(repo);
  return hints.length > 0 ? `${failure}. ${hints.join("; ")}` : failure;
}

/**
 * Run the test command once on an unmodified worktree at `base`. The worktree is always
 * removed. Never reruns. On failure the reason is the failure kind plus any hints.
 */
export async function runBaseline(
  repo: string,
  base: string,
  plan: DepsPlan,
  opts: BaselineOptions,
  signal?: AbortSignal,
): Promise<BaselineResult> {
  signal?.throwIfAborted();
  let wt: string;
  try {
    wt = await createWorktree(repo, base);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      passed: false,
      reason: await withHints(repo, "worktree setup failed"),
      excerpt: msg.slice(-opts.excerptChars),
    };
  }

  const linkPath = path.join(wt, "node_modules");
  let outcome: BaselineResult = {
    passed: false,
    reason: await withHints(repo, "internal error"),
    excerpt: "",
  };
  try {
    signal?.throwIfAborted();
    const deps = await setupDeps(repo, wt, plan, opts, signal);
    if (!deps.ok) {
      outcome = { passed: false, reason: await withHints(repo, deps.reason), excerpt: deps.excerpt };
    } else {
      signal?.throwIfAborted();
      const r = await runCommand(opts.testCommand, wt, {
        timeoutMs: opts.timeoutMs,
        excerptChars: opts.excerptChars,
      });
      if (r.spawnError !== undefined) {
        outcome = {
          passed: false,
          reason: await withHints(repo, "test command failed to start"),
          excerpt: r.spawnError,
        };
      } else if (r.timedOut) {
        outcome = { passed: false, reason: await withHints(repo, "timeout"), excerpt: r.output };
      } else if (r.code !== 0) {
        outcome = { passed: false, reason: await withHints(repo, "tests failed"), excerpt: r.output };
      } else {
        outcome = { passed: true, excerpt: r.output };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outcome = {
        passed: false,
        reason: await withHints(repo, "internal error"),
        excerpt: msg.slice(-opts.excerptChars),
    };
  } finally {
    // Cleanup is independent of the test result. Retain both warning and thrown-error state.
    try {
      const cleanup = await removeWorktree(
        repo,
        wt,
        (await isLink(linkPath)) ? linkPath : undefined,
      );
      if (cleanup.cleanupWarning !== undefined) outcome.cleanupWarning = cleanup.cleanupWarning;
    } catch (e) {
      outcome.cleanupError = e instanceof Error ? e.message : String(e);
    }
    outcome.worktreePath = wt;
  }
  return outcome;
}
