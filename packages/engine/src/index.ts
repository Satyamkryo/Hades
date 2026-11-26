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
export { HadesConfigError } from "./errors.js";
export { matchRules } from "./history/candidates.js";
export {
  makeTestFileMatcher,
  makeNonCodeMatcher,
  DEFAULT_TEST_PATTERNS,
  DEFAULT_NON_CODE_PATTERNS,
} from "./classify/files.js";
