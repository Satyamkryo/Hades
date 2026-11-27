import { makeNonCodeMatcher, makeTestFileMatcher } from "../classify/files.js";
import { matchRules } from "../history/candidates.js";
import type { ScannedCommit } from "./scan.js";

export interface FileScore {
  path: string;
  score: number;
  fixes: number;
  reverts: number;
  churn: number;
  fixShas: string[];
  revertShas: string[];
}

export interface ScoreOptions {
  top?: number;
  extraTestPatterns?: readonly string[];
  extraNonCodePatterns?: readonly string[];
}

/**
 * Rank source files by their fix history. Reverts count as fixes with extra
 * weight (a revert is a fix that failed once already); plain commits add only
 * churn. Only paths present at HEAD and neither test nor non-code files are
 * counted. Every counted file has churn ≥ 1, so no score is 0.
 */
export function scoreFiles(
  commits: ScannedCommit[],
  headPaths: Set<string>,
  opts: ScoreOptions = {},
): FileScore[] {
  const top = opts.top ?? 10;
  const isTest = makeTestFileMatcher(opts.extraTestPatterns ?? []);
  const isNonCode = makeNonCodeMatcher(opts.extraNonCodePatterns ?? []);
  const byPath = new Map<string, FileScore>();

  for (const commit of commits) {
    const rules = matchRules(commit.message);
    const kind = rules.includes("revert") ? "revert" : rules.length > 0 ? "fix" : "plain";
    for (const path of commit.paths) {
      if (!headPaths.has(path) || isTest(path) || isNonCode(path)) {
        continue;
      }
      let entry = byPath.get(path);
      if (entry === undefined) {
        entry = { path, score: 0, fixes: 0, reverts: 0, churn: 0, fixShas: [], revertShas: [] };
        byPath.set(path, entry);
      }
      entry.churn += 1;
      if (kind === "fix") {
        entry.fixes += 1;
        entry.fixShas.push(commit.sha);
      } else if (kind === "revert") {
        entry.reverts += 1;
        entry.revertShas.push(commit.sha);
      }
    }
  }

  return [...byPath.values()]
    .map((entry) => ({ ...entry, score: 3 * entry.fixes + 2 * entry.reverts + entry.churn / 10 }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, top);
}
