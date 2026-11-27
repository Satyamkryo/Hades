import type { FoundBy, HistoryCommit } from "./types.js";
import type { ParsedLogCommit } from "./parse-log.js";

export interface HistoryParts {
  /** Whole-file history. Its diff wins when a commit also comes from elsewhere. */
  fileLog: ParsedLogCommit[];
  symbolLog: ParsedLogCommit[];
  /** `--no-walk` reads for blame SHAs; these carry no diff. */
  blame: ParsedLogCommit[];
}

/**
 * Union the reads by SHA. `foundBy` is the set of reads that returned the
 * commit; when the file log and the symbol log return the same commit, the
 * commit keeps the file-log diff. Order: committer time descending, then SHA
 * ascending, so the order is stable across cache hits.
 */
export function mergeHistory(parts: HistoryParts): HistoryCommit[] {
  const bySha = new Map<string, { commit: ParsedLogCommit; foundBy: FoundBy[] }>();
  const add = (commits: ParsedLogCommit[], foundBy: FoundBy): void => {
    for (const commit of commits) {
      const existing = bySha.get(commit.sha);
      if (existing === undefined) {
        bySha.set(commit.sha, { commit, foundBy: [foundBy] });
      } else {
        if (!existing.foundBy.includes(foundBy)) {
          existing.foundBy.push(foundBy);
        }
        // Processed blame, symbol-log, file-log: later lists win the fields.
        existing.commit = commit;
      }
    }
  };
  add(parts.blame, "blame");
  add(parts.symbolLog, "symbol-log");
  add(parts.fileLog, "file-log");
  return [...bySha.values()]
    .sort(
      (a, b) =>
        b.commit.committerTime - a.commit.committerTime ||
        (a.commit.sha < b.commit.sha ? -1 : a.commit.sha > b.commit.sha ? 1 : 0),
    )
    .map(({ commit, foundBy }) => ({
      sha: commit.sha,
      message: commit.message,
      author: commit.author,
      date: commit.date,
      diff: commit.diff,
      diffTruncated: commit.diffTruncated,
      foundBy: [...foundBy].sort(),
    }));
}
