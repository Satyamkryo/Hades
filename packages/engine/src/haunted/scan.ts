import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { runGit } from "../git/exec.js";

export interface ScannedCommit {
  sha: string;
  message: string;
  /** Repo-relative paths with `/` separators, C-unquoted. */
  paths: string[];
}

export interface ScanResult {
  commits: ScannedCommit[];
  /** Paths present at HEAD. */
  headPaths: Set<string>;
}

const SHA_40 = /^[0-9a-f]{40}$/;

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

/**
 * Undo git's C-style path quoting (`-c core.quotePath=false` still quotes
 * paths holding `"`, `\` or control characters): `"a\"b"` → `a"b`, octal
 * bytes → UTF-8 text. Unquoted paths pass through untouched.
 */
export function unquotePath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const body = path.slice(1, -1);
  const parts: Buffer[] = [];
  let textStart = 0;
  let i = 0;
  const flushText = (end: number): void => {
    if (end > textStart) {
      parts.push(Buffer.from(body.slice(textStart, end), "utf8"));
    }
  };
  while (i < body.length) {
    if (body[i] !== "\\") {
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      break;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      flushText(i);
      parts.push(Buffer.from(simple, "utf8"));
      i += 2;
      textStart = i;
    } else if (next >= "0" && next <= "7") {
      const octal = body.slice(i + 1, i + 4);
      if (/^[0-7]{1,3}$/.test(octal)) {
        flushText(i);
        parts.push(Buffer.from([Number.parseInt(octal, 8)]));
        i += 1 + octal.length;
        textStart = i;
      } else {
        i += 1;
      }
    } else {
      // Not one of git's escapes: keep both characters as-is.
      i += 2;
    }
  }
  flushText(body.length);
  return Buffer.concat(parts).toString("utf8");
}

function parseLog(stdout: string, marker: string): ScannedCommit[] {
  const commits: ScannedCommit[] = [];
  for (const segment of stdout.split(`\x1e${marker}\n`)) {
    // `%H%x00%B%x00`, then one path per line. Bodies cannot hold NUL, so the
    // first two fields are fixed and the rest (rejoined) holds the paths.
    const fields = segment.split("\0");
    if (fields.length < 2) {
      continue;
    }
    const [sha, body] = fields as [string, string];
    if (sha === undefined || !SHA_40.test(sha)) {
      continue;
    }
    const paths = fields
      .slice(2)
      .join("\0")
      .split("\n")
      .filter((line) => line !== "")
      .map(unquotePath);
    commits.push({ sha, message: (body ?? "").replace(/\r?\n$/, ""), paths });
  }
  return commits;
}

/**
 * Two git calls: the name-only history (merges excluded, renames listed under
 * both names) and the path set at the recorded head. RankHaunted never touches the cache.
 */
export async function scanRepoHistory(
  repo: string,
  maxCommits: number,
  headSha: string,
): Promise<ScanResult> {
  const marker = `HADES-${randomBytes(8).toString("hex")}`;
  const log = await runGit(repo, [
    "-c",
    "core.quotePath=false",
    "log",
    "--no-merges",
    "--no-renames",
    "-n",
    String(maxCommits),
    "--name-only",
    `--format=%x1e${marker}%n%H%x00%B%x00`,
    headSha,
  ]);
  const tree = await runGit(repo, ["ls-tree", "-r", "-z", "--name-only", headSha]);
  const headPaths = new Set(tree.stdout.split("\0").filter((p) => p !== ""));
  return { commits: parseLog(log.stdout, marker), headPaths };
}
