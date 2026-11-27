import type { HistoryCommit } from "./types.js";

/**
 * A log commit with its committer timestamp, used to order merged reads.
 * `committerTime` is stripped by `mergeHistory` and never leaves the engine.
 */
export interface ParsedLogCommit extends HistoryCommit {
  committerTime: number;
}

const SHA_40 = /^[0-9a-f]{40}$/;

/**
 * Parse `git log` output written with a per-call random marker
 * (`--format=%x1e<marker>%n%H%x00%P%x00%an%x00%aI%x00%ct%x00%B%x00`).
 * Commit messages and diffs are untrusted: only the exact delimiter
 * `\x1e<marker>\n` starts a record, so `\x1e` or marker text inside a message
 * cannot fake a record boundary. Merge commits (2+ parents) are dropped; root
 * commits are kept. Records with a malformed SHA or timestamp are skipped.
 */
export function parseLog(
  stdout: string,
  marker: string,
  excerptChars: number,
): ParsedLogCommit[] {
  const commits: ParsedLogCommit[] = [];
  for (const segment of stdout.split(`\x1e${marker}\n`)) {
    // %H %P %an %aI %ct %B, then the patch. Bodies cannot contain NUL, so the
    // first six fields are fixed and the rest (rejoined) is the patch.
    const fields = segment.split("\0");
    if (fields.length < 6) {
      continue;
    }
    const [sha, parents, author, date, ctRaw, body] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (sha === undefined || !SHA_40.test(sha)) {
      continue;
    }
    const committerTime = Number.parseInt(ctRaw ?? "", 10);
    if (!Number.isFinite(committerTime)) {
      continue;
    }
    if ((parents ?? "").split(" ").filter(Boolean).length >= 2) {
      continue;
    }
    // git appends a newline after each record; it terminates the record and
    // is not diff content (a --no-patch read leaves just this newline).
    const rawPatch = fields.slice(6).join("\0");
    const patch = rawPatch.endsWith("\n") ? rawPatch.slice(0, -1) : rawPatch;
    let diff = patch.slice(0, excerptChars);
    const diffTruncated = patch.length > excerptChars;
    if (diffTruncated && /[\uD800-\uDBFF]$/.test(diff)) {
      diff = diff.slice(0, -1);
    }
    commits.push({
      sha,
      message: (body ?? "").replace(/\r?\n$/, ""),
      author: author ?? "",
      date: date ?? "",
      diff,
      diffTruncated,
      foundBy: [],
      committerTime,
    });
  }
  return commits;
}
