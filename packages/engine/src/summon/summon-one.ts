import fs from "node:fs/promises";
import path from "node:path";
import {
  makeNonCodeMatcher,
  makeTestFileMatcher,
  selectFiles,
} from "../classify/files.js";
import { throwIfAborted } from "../abort.js";
import type { ResolvedOptions } from "../config.js";
import { HadesAbortError, ParentUnavailableError } from "../errors.js";
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
  | "rerunOnFail"
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
 * On a non-zero test exit the tests are rerun up to `rerunOnFail` times: a passing rerun
 * means `lost` (`flaky tests`), otherwise the failure stands (`buried`).
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
    runs = 1,
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
    runs,
    ...(cleanupWarning !== undefined ? { cleanupWarning } : {}),
  });

  let source: string[];
  let patch: string;
  try {
    throwIfAborted(signal);
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
    throwIfAborted(signal);
    if ((e as Error)?.name === "HadesAbortError" || e instanceof HadesAbortError) throw e;
    if (e instanceof ParentUnavailableError) {
      return entry("lost", [], "", "parent commit not available");
    }
    return entry("lost", [], "", `internal error: ${e instanceof Error ? e.message : String(e)}`);
  }

  throwIfAborted(signal);
  let wt: string | undefined;
  try {
    try {
      wt = await createWorktree(repo, base);
    } catch (e) {
      throwIfAborted(signal);
      if ((e as Error)?.name === "HadesAbortError") throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return entry("lost", source!, msg.slice(-opts.excerptChars), `internal error: worktree setup failed: ${msg.split("\n")[0] ?? ""}`);
    }

    const linkPath = path.join(wt, "node_modules");
    let result: SummonEntry;
    let cleanupWarning: string | undefined;
    try {
      // Right after creation, inside the try whose finally removes the worktree.
      throwIfAborted(signal);
      const applied = await reverseApply(wt, patch!, opts.excerptChars);
      if (!applied.ok) {
        result = entry("lost", source!, applied.excerpt, applied.reason);
      } else {
        throwIfAborted(signal);
        const deps = await setupDeps(repo, wt, plan, opts, signal);
        if (!deps.ok) {
          result = entry("lost", source!, deps.excerpt, deps.reason);
        } else {
          throwIfAborted(signal);
          const first = await runCommand(opts.testCommand, wt, {
            timeoutMs: opts.timeoutMs,
            excerptChars: opts.excerptChars,
            ...(signal !== undefined ? { signal } : {}),
          });
          if (first.spawnError !== undefined) {
            result = entry("lost", source!, first.spawnError, "test command failed to start");
          } else if (first.timedOut) {
            result = entry("lost", source!, first.output, "timeout");
          } else if (first.code === 0) {
            result = entry("escaped", source!, first.output);
          } else {
            // Non-zero exit: rerun up to rerunOnFail times. A passing rerun means the
            // failure was flaky; otherwise the failure stands. A rerun that times out
            // or fails to start counts as a failed rerun. The excerpt stays the first
            // failing run's output, since that shows what broke.
            let runs = 1;
            let passed = false;
            for (let i = 0; i < opts.rerunOnFail && !passed; i++) {
              throwIfAborted(signal);
              const retry = await runCommand(opts.testCommand, wt, {
                timeoutMs: opts.timeoutMs,
                excerptChars: opts.excerptChars,
                ...(signal !== undefined ? { signal } : {}),
              });
              runs += 1;
              passed = retry.spawnError === undefined && !retry.timedOut && retry.code === 0;
            }
            result = passed
              ? entry("lost", source!, first.output, "flaky tests", undefined, runs)
              : entry("buried", source!, first.output, undefined, undefined, runs);
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name === "HadesAbortError" || e instanceof HadesAbortError) throw e;
      result = entry(
        "lost",
        source!,
        "",
        `internal error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      // Pass the link path only when it is really a link, so it is removed without recursion.
      // Cleanup never takes the signal.
      const cleanup = await removeWorktree(repo, wt, (await isLink(linkPath)) ? linkPath : undefined)
        .catch((e: unknown) => ({
          cleanupWarning: `cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
        }));
      cleanupWarning = cleanup.cleanupWarning;
    }
    if (cleanupWarning !== undefined) result!.cleanupWarning = cleanupWarning;
    result!.durationMs = Date.now() - start;
    return result!;
  } catch (e) {
    if (wt !== undefined) {
      try {
        const linkPath = path.join(wt, "node_modules");
        await removeWorktree(repo, wt, (await isLink(linkPath)) ? linkPath : undefined).catch(
          () => undefined,
        );
      } catch {
        // Never hide the abort.
      }
    }
    throw e;
  }
}
