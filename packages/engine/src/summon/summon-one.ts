import fs from "node:fs/promises";
import path from "node:path";
import {
  makeNonCodeMatcher,
  makeTestFileMatcher,
  selectFiles,
} from "../classify/files.js";
import type { ResolvedOptions } from "../config.js";
import { ParentUnavailableError } from "../errors.js";
import { changesDependencies } from "../history/dependency-change.js";
import { changedFiles, fixPatch } from "../history/fix-diff.js";
import type { ConfirmedFix } from "../llm/confirm-loop.js";
import type { LostReason, SummonEntry } from "../report/types.js";
import { reverseApply } from "./apply.js";
import type { DepsPlan } from "./deps-plan.js";
import { setupDeps } from "./deps.js";
import { runCommand } from "./process.js";
import { createWorktree, removeWorktree } from "./worktree.js";

export type SummonOneOptions = Pick<
  ResolvedOptions,
  | "testCommand"
  | "timeoutMs"
  | "installCommand"
  | "installTimeoutMs"
  | "excerptChars"
  | "extraTestPatterns"
  | "extraNonCodePatterns"
>;

async function isLink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Summon one Confirmed fix: revert its Source files in a temporary worktree at `base`,
 * run the tests, and label the result. Always returns exactly one entry; any unexpected
 * error becomes `lost` with `internal error: <message>`. The worktree is always removed.
 * (Reruns on failure are an optional later feature; `runs` is always 1 here.)
 */
export async function summonOne(
  repo: string,
  base: string,
  fix: ConfirmedFix,
  plan: DepsPlan,
  opts: SummonOneOptions,
  signal?: AbortSignal,
): Promise<SummonEntry> {
  const start = Date.now();
  const entry = (
    label: SummonEntry["label"],
    filesReverted: string[],
    excerpt: string,
    lostReason?: LostReason,
    cleanupWarning?: string,
  ): SummonEntry => ({
    sha: fix.sha,
    message: fix.message,
    matchedRules: fix.matchedRules,
    llmReason: fix.llmReason,
    filesReverted,
    label,
    ...(lostReason !== undefined ? { lostReason } : {}),
    testOutputExcerpt: excerpt,
    durationMs: Date.now() - start,
    runs: 1,
    ...(cleanupWarning !== undefined ? { cleanupWarning } : {}),
  });

  let source: string[];
  let patch: string;
  try {
    const files = await changedFiles(repo, fix.sha);
    const sel = selectFiles(files, {
      isTest: makeTestFileMatcher(opts.extraTestPatterns),
      isNonCode: makeNonCodeMatcher(opts.extraNonCodePatterns),
    });
    // Both early exits happen before any worktree exists.
    if (sel.source.length === 0) return entry("lost", [], "", "no source files to revert");
    if (plan.method === "link" && (await changesDependencies(repo, fix.sha, sel.nonTest))) {
      return entry("lost", [], "", "fix changes dependencies");
    }
    source = sel.source;
    patch = await fixPatch(repo, fix.sha, source);
  } catch (e) {
    if (e instanceof ParentUnavailableError) {
      return entry("lost", [], "", "parent commit not available");
    }
    return entry("lost", [], "", `internal error: ${e instanceof Error ? e.message : String(e)}`);
  }

  signal?.throwIfAborted();
  let wt: string;
  try {
    wt = await createWorktree(repo, base);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return entry("lost", source, msg.slice(-opts.excerptChars), `internal error: worktree setup failed: ${msg.split("\n")[0] ?? ""}`);
  }

  const linkPath = path.join(wt, "node_modules");
  let result: SummonEntry;
  let cleanupWarning: string | undefined;
  try {
    signal?.throwIfAborted();
    const applied = await reverseApply(wt, patch, opts.excerptChars);
    if (!applied.ok) {
      result = entry("lost", source, applied.excerpt, applied.reason);
    } else {
      signal?.throwIfAborted();
      const deps = await setupDeps(repo, wt, plan, opts, signal);
      if (!deps.ok) {
        result = entry("lost", source, deps.excerpt, deps.reason);
      } else {
        signal?.throwIfAborted();
        const r = await runCommand(opts.testCommand, wt, {
          timeoutMs: opts.timeoutMs,
          excerptChars: opts.excerptChars,
        });
        if (r.spawnError !== undefined) {
          result = entry("lost", source, r.spawnError, "test command failed to start");
        } else if (r.timedOut) {
          result = entry("lost", source, r.output, "timeout");
        } else if (r.code === 0) {
          result = entry("escaped", source, r.output);
        } else {
          result = entry("buried", source, r.output);
        }
      }
    }
  } catch (e) {
    result = entry(
      "lost",
      source,
      "",
      `internal error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Pass the link path only when it is really a link, so it is removed without recursion.
    const cleanup = await removeWorktree(repo, wt, (await isLink(linkPath)) ? linkPath : undefined)
      .catch((e: unknown) => ({
        cleanupWarning: `cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
      }));
    cleanupWarning = cleanup.cleanupWarning;
  }
  if (cleanupWarning !== undefined) result.cleanupWarning = cleanupWarning;
  result.durationMs = Date.now() - start;
  return result;
}
