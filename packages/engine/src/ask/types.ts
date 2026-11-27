// Shared history-reader types. Plain JSON-serialisable objects, ready for the
// MCP layer. `review-comment` sources stay empty until task 15 is built.

export type FoundBy = "blame" | "file-log" | "symbol-log";
export type EchoConfidence = "said" | "inferred" | "none";

export interface BlameRange {
  start: number;
  end: number;
  sha: string;
}

export interface HistoryCommit {
  /** Full 40-char SHA. */
  sha: string;
  message: string;
  /** Author name only. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Diff excerpt, at most `excerptChars` UTF-16 units, limited to the target file. */
  diff: string;
  diffTruncated: boolean;
  /** The reads that returned this commit. Sorted. */
  foundBy: FoundBy[];
}

export interface EchoSource {
  kind: "commit-message" | "pr-body" | "review-comment" | "issue-body";
  /** SHA, PR number, issue number or comment id, as a string. */
  ref: string;
  url?: string;
}

export interface Echo {
  sha: string;
  prNumber?: number;
  issueNumbers: number[];
  url?: string;
  confidence: EchoConfidence;
  /**
   * `said`: exact quote; `inferred`: `<sha7>: ...` (contains "probably");
   * `none`: NO_RECORD_TEXT.
   */
  text: string;
  /** Set for `said` only. */
  source?: EchoSource;
  /** Set for `said` only. */
  truncated?: boolean;
}

export const NO_RECORD_TEXT =
  "No commit message, pull request or issue explains this change.";

export interface HistoryAnswer {
  repo: string;
  /** Normalised, repo-relative target file. */
  file: string;
  /** Null for an empty repo. */
  headSha: string | null;
  lines?: [number, number];
  symbol?: string;
  github:
    | { mode: "local" }
    | { mode: "github"; repo: string; disabled?: true; requests: number; rateLimited: boolean };
  blame: BlameRange[];
  commits: HistoryCommit[];
  /** One echo per commit, in the same order. */
  echoes: Echo[];
  warnings: string[];
}

export interface HauntedFile {
  path: string;
  score: number;
  fixes: number;
  reverts: number;
  churn: number;
  fixShas: string[];
  revertShas: string[];
  escapedSouls?: string[];
}

export interface HauntedReport {
  repo: string;
  headSha: string | null;
  commitsScanned: number;
  files: HauntedFile[];
  /** File name of the summoning report used, if any. */
  report?: string;
  warnings: string[];
}
