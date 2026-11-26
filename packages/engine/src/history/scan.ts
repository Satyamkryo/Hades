import { runGit } from "../git/exec.js";

export interface CommitInfo {
  sha: string;
  parent: string;
  message: string;
}

/**
 * Read the newest `maxCommits` commits reachable from HEAD, newest first.
 * %x00 separates SHA, parent list and raw body; %x1e ends each commit.
 * Root commits (no parent) and merge commits (2+ parents) are dropped.
 */
export async function scanCommits(
  repo: string,
  maxCommits: number,
  baseSha = "HEAD",
): Promise<CommitInfo[]> {
  const { stdout } = await runGit(repo, [
    "log",
    "-n",
    String(maxCommits),
    "--format=%H%x00%P%x00%B%x1e",
    baseSha,
  ]);

  const commits: CommitInfo[] = [];
  for (const raw of stdout.split("\x1e")) {
    // git prints a newline before every record after the first; trim before splitting.
    const record = raw.trim();
    if (record === "") continue;
    const first = record.indexOf("\0");
    const second = first === -1 ? -1 : record.indexOf("\0", first + 1);
    if (second === -1) continue;
    const sha = record.slice(0, first);
    const parents = record.slice(first + 1, second).split(" ").filter(Boolean);
    if (parents.length !== 1) continue;
    commits.push({ sha, parent: parents[0]!, message: record.slice(second + 1).trim() });
  }
  return commits;
}
