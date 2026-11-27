// Pure candidate rules: decide from a commit message whether it might be a bug fix.
// There is deliberately no rule for a bare `#123` (it says nothing about bugs).

import type { Candidate } from "../llm/confirm-loop.js";
import type { CandidateRule } from "../report/types.js";
import { CLOSING_ISSUE } from "./closing-issues.js";
import type { CommitInfo } from "./scan.js";

export type { CandidateRule };

const KEYWORD = /\b(fix|fixes|fixed|fixing|bugfix|bug|crash|hotfix|revert)\b/i;
const REVERT_SUBJECT = /^Revert "/;
const REVERT_BODY = /This reverts commit [0-9a-f]{7,40}/;

/** Returns every rule the message matches; a non-empty result means "Candidate". */
export function matchRules(message: string): CandidateRule[] {
  const rules: CandidateRule[] = [];
  if (KEYWORD.test(message)) rules.push("keyword");
  if (CLOSING_ISSUE.test(message)) rules.push("closing-issue");
  const subject = message.split(/\r?\n/, 1)[0] ?? "";
  if (REVERT_SUBJECT.test(subject) || REVERT_BODY.test(message)) rules.push("revert");
  return rules;
}

/** At most this many scanned commits -> diff-review mode. */
export const DIFF_REVIEW_MAX_HISTORY = 50;
/** Fewer message matches than this -> diff-review mode. */
export const DIFF_REVIEW_MIN_MATCHES = 3;

export interface CandidateSelection {
  mode: "message" | "diff-review";
  candidates: Candidate[];
}

/**
 * Pick Candidates from scanned commits (newest first). Small or poorly worded histories
 * use diff-review: every commit is a Candidate and the LLM judges message plus diff.
 */
export function selectCandidates(commits: CommitInfo[]): CandidateSelection {
  const withRules = commits.map((c) => ({ ...c, matchedRules: matchRules(c.message) }));
  const matched = withRules.filter((c) => c.matchedRules.length > 0);
  if (commits.length <= DIFF_REVIEW_MAX_HISTORY || matched.length < DIFF_REVIEW_MIN_MATCHES) {
    return {
      mode: "diff-review",
      candidates: withRules.map((c) => ({
        ...c,
        matchedRules: [...c.matchedRules, "diff-review" as const],
      })),
    };
  }
  return { mode: "message", candidates: matched };
}
