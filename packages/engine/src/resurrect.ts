import { resolveOptions, type ResolvedOptions, type ResurrectDeps, type ResurrectOptions } from "./config.js";
import { changedFiles, diffSummary } from "./history/fix-diff.js";
import { selectCandidates } from "./history/candidates.js";
import { scanCommits } from "./history/scan.js";
import { createOpenAiCompatibleClient } from "./llm/client.js";
import { confirmCandidates, type ConfirmationOutcome } from "./llm/confirm-loop.js";
import { readLlmEnv } from "./llm/env.js";
import type { LlmClient } from "./llm/types.js";
import { redactOptions } from "./report/redact.js";
import type { SummonEntry, UnguardedFix, UnderworldReport } from "./report/types.js";
import { verifyAndTotal, type PhaseTotals, type UnverifiedReport } from "./report/verify.js";
import { hasTestSuite } from "./repo/test-suite.js";
import { validateRepo } from "./repo/validate.js";
import { runBaseline } from "./summon/baseline.js";
import { planDeps, type DepsPlan } from "./summon/deps-plan.js";
import { summonOne } from "./summon/summon-one.js";

const NO_DEPS: DepsPlan = { method: "none", workspace: false };

/**
 * Run the whole summoning flow on a repo and return the Underworld report.
 * Never touches the real working tree: all test runs happen in temporary worktrees.
 * Order: validate, scan, select Candidates, test-suite check (only when the caller did not
 * set `testCommand`), LLM env, then baseline + confirm + summon (or confirm only for
 * `no-tests`), verify SHAs, redact options.
 */
export async function resurrect(
  repoPath: string,
  options?: ResurrectOptions,
  deps: ResurrectDeps = {},
): Promise<UnderworldReport> {
  const opts: ResolvedOptions = resolveOptions(options);
  const signal = deps.signal;
  signal?.throwIfAborted();
  // Checked on the raw input: an explicit testCommand always runs as usual.
  const explicitTestCommand = options?.testCommand !== undefined;

  const { repo, baseSha } = await validateRepo(repoPath);
  const apiKey = process.env["HADES_LLM_API_KEY"]?.trim() || undefined;
  const safeOptions = (): ResolvedOptions => redactOptions(opts, apiKey);

  const emptyPhase: PhaseTotals = {
    commitsScanned: 0,
    candidates: 0,
    rejectedByLlm: 0,
    llmErrors: 0,
    unchecked: 0,
    staleCleaned: 0,
  };

  if (baseSha === undefined) {
    // Empty repo: nothing to scan, and no commit to verify.
    return {
      status: "ok",
      repo,
      baseSha: "",
      options: safeOptions(),
      deps: NO_DEPS,
      warnings: [],
      entries: [],
      unguarded: [],
      rejected: [],
      llmErrors: [],
      totals: { ...emptyPhase, processed: 0, escaped: 0, buried: 0, lost: 0, unguarded: 0 },
      droppedUnverified: [],
    };
  }

  const commits = await scanCommits(repo, opts.maxCommits, baseSha);
  const { candidates } = selectCandidates(commits);

  const noTests = !explicitTestCommand && !(await hasTestSuite(repo, baseSha));

  const base = {
    repo,
    baseSha,
    options: safeOptions(),
    warnings: [] as string[],
    entries: [] as SummonEntry[],
    unguarded: [] as UnguardedFix[],
    rejected: [] as UnverifiedReport["rejected"],
    llmErrors: [] as UnverifiedReport["llmErrors"],
  };
  const phase = (outcome?: ConfirmationOutcome): PhaseTotals => ({
    commitsScanned: commits.length,
    candidates: candidates.length,
    rejectedByLlm: outcome?.rejected.length ?? 0,
    llmErrors: outcome?.llmErrors.length ?? 0,
    unchecked: outcome?.unchecked ?? 0,
    staleCleaned: 0,
  });

  // No Candidates: no LLM env, worktree or tests needed.
  if (candidates.length === 0) {
    return verifyAndTotal(
      repo,
      { ...base, status: noTests ? "no-tests" : "ok", deps: NO_DEPS },
      phase(),
    );
  }

  // Fail fast on a missing LLM variable, before any worktree exists.
  const llm: LlmClient = deps.llm ?? createOpenAiCompatibleClient(readLlmEnv());

  let plan: DepsPlan = NO_DEPS;
  let baseline: UnderworldReport["baseline"];
  if (!noTests) {
    plan = await planDeps(repo, opts);
    if (plan.warning !== undefined) base.warnings.push(plan.warning);

    // Baseline runs before the LLM, so a broken test suite costs no LLM calls.
    signal?.throwIfAborted();
    const result = await runBaseline(repo, baseSha, plan, opts, signal);
    signal?.throwIfAborted();
    baseline = result.passed
      ? { passed: true, excerpt: result.excerpt, worktreePath: result.worktreePath, cleanupWarning: result.cleanupWarning, cleanupError: result.cleanupError }
      : {
          passed: false,
          reason: result.reason,
          excerpt: result.excerpt,
          worktreePath: result.worktreePath,
          cleanupWarning: result.cleanupWarning,
          cleanupError: result.cleanupError,
        };
    if (!result.passed) {
      return verifyAndTotal(
        repo,
        { ...base, status: "baseline-failed", deps: planInfo(plan), baseline },
        phase(),
      );
    }
  }

  const outcome = await confirmCandidates(llm, candidates, opts, (sha) =>
    diffSummary(repo, sha), signal,
  );
  signal?.throwIfAborted();
  base.rejected = outcome.rejected;
  base.llmErrors = outcome.llmErrors;

  if (noTests) {
    // Nothing is reverted or run, so no worktree is created.
    for (const fix of outcome.confirmed) {
      const files = await changedFiles(repo, fix.sha).catch(() => [] as string[]);
      base.unguarded.push({
        sha: fix.sha,
        message: fix.message,
        matchedRules: fix.matchedRules,
        llmReason: fix.llmReason,
        files,
      });
    }
  } else {
    // One at a time: predictable CPU, disk and port use, and simple cleanup.
    for (const fix of outcome.confirmed) {
      signal?.throwIfAborted();
      base.entries.push(await summonOne(repo, baseSha, fix, plan, opts, signal));
      signal?.throwIfAborted();
    }
  }

  return verifyAndTotal(
    repo,
    {
      ...base,
      status: noTests ? "no-tests" : "ok",
      deps: planInfo(plan),
      ...(baseline !== undefined ? { baseline } : {}),
    },
    phase(outcome),
  );
}

function planInfo(plan: DepsPlan): { method: DepsPlan["method"]; workspace: boolean } {
  return { method: plan.method, workspace: plan.workspace };
}
