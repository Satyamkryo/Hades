export { resurrect } from "./resurrect.js";
export type { ResurrectOptions, ResurrectDeps, ResolvedOptions } from "./config.js";
export type { LlmClient } from "./llm/types.js";
export type {
  UnderworldReport,
  SummonEntry,
  SummonLabel,
  LostReason,
  UnguardedFix,
  CandidateRule,
  CommitNote,
  ReportTotals,
} from "./report/types.js";
export { HadesAbortError, HadesConfigError } from "./errors.js";
export { throwIfAborted } from "./abort.js";
export { askHistory } from "./ask/ask-history.js";
export type { AskHistoryOptions, HistoryDeps } from "./ask/ask-history.js";
export type {
  HistoryAnswer,
  HistoryCommit,
  BlameRange,
  Echo,
  EchoConfidence,
  EchoSource,
} from "./ask/types.js";
export type { GithubClient, GhResult, GhPull, GhReviewComment, GhIssue } from "./github/types.js";
export { rankHaunted } from "./haunted/rank-haunted.js";
export type { RankHauntedOptions } from "./haunted/rank-haunted.js";
export type { HauntedReport, HauntedFile } from "./ask/types.js";
export { matchRules } from "./history/candidates.js";
export {
  makeTestFileMatcher,
  makeNonCodeMatcher,
  DEFAULT_TEST_PATTERNS,
  DEFAULT_NON_CODE_PATTERNS,
} from "./classify/files.js";
