import type { ResolvedOptions } from "../config.js";

export type CandidateRule = "keyword" | "closing-issue" | "revert" | "diff-review";

export type SummonLabel = "escaped" | "buried" | "lost";

export type LostReason =
  | "revert did not apply"
  | "timeout"
  | "dependency setup failed"
  | "no source files to revert"
  | "fix changes dependencies"
  | "flaky tests"
  | "test command failed to start"
  | "parent commit not available"
  | `internal error: ${string}`;

export interface SummonEntry {
  /** Full 40-char SHA. */
  sha: string;
  message: string;
  matchedRules: CandidateRule[];
  llmReason: string;
  filesReverted: string[];
  label: SummonLabel;
  lostReason?: LostReason;
  testOutputExcerpt: string;
  durationMs: number;
  /** 1 + reruns performed (1 when reruns are disabled). */
  runs: number;
  cleanupWarning?: string;
}

/** Confirmed fix in a repo with no test suite. */
export interface UnguardedFix {
  /** Full 40-char SHA. */
  sha: string;
  message: string;
  matchedRules: CandidateRule[];
  llmReason: string;
  /** Every path the fix changed, unclassified. */
  files: string[];
}

export interface CommitNote {
  sha: string;
  message: string;
  reason: string;
}

export interface ReportTotals {
  // From the scan, confirm and cleanup phases.
  commitsScanned: number;
  candidates: number;
  rejectedByLlm: number;
  llmErrors: number;
  unchecked: number;
  /** 0 until optional stale cleanup exists. */
  staleCleaned: number;
  // Derived from entries.
  processed: number;
  escaped: number;
  buried: number;
  lost: number;
  // Derived from the unguarded list.
  unguarded: number;
}

export interface UnderworldReport {
  status: "ok" | "baseline-failed" | "no-tests";
  repo: string;
  baseSha: string;
  /** Redacted. */
  options: ResolvedOptions;
  deps: { method: "link" | "install" | "none"; workspace: boolean };
  warnings: string[];
  baseline?: {
    passed: boolean;
    reason?: string;
    excerpt: string;
    worktreePath?: string;
    cleanupWarning?: string;
    cleanupError?: string;
  };
  /** Always empty for no-tests. */
  entries: SummonEntry[];
  /** Only filled for no-tests. */
  unguarded: UnguardedFix[];
  /** LLM said: not a bug fix. */
  rejected: CommitNote[];
  /** LLM request failed or response invalid. */
  llmErrors: CommitNote[];
  totals: ReportTotals;
  /** SHAs removed by verification (expected empty). */
  droppedUnverified: string[];
}
