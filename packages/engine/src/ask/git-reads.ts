import { createHash, randomBytes } from "node:crypto";
import { GitError } from "../errors.js";
import { runGit } from "../git/exec.js";
import { parseBlame } from "./parse-blame.js";
import { parseLog, type ParsedLogCommit } from "./parse-log.js";
import type { BlameRange } from "./types.js";

/** Random per-call record marker, so untrusted diff text cannot fake a record boundary. */
export function newHistoryMarker(): string {
  return `HADES-${randomBytes(8).toString("hex")}`;
}

export function gitLogFormat(marker: string): string {
  return `--format=%x1e${marker}%n%H%x00%P%x00%an%x00%aI%x00%ct%x00%B%x00`;
}

// git treats `<funcname>` as a basic regular expression: escape what is special
// in both basic and extended regex, so a symbol matches literally. `(` `)` `+`
// `|` and `{` `}` stay unescaped: under basic regex they are literal, and
// escaping them breaks the match ("Unmatched ( or \\(").
const SYMBOL_ESCAPE = /[\\.\[\]*^$]/g;

/** Escape a symbol for `-L :<symbol>:<file>` so it matches literally. */
export function escapeSymbol(symbol: string): string {
  return symbol.replace(SYMBOL_ESCAPE, "\\$&");
}

export interface HistoryReadOptions {
  repo: string;
  file: string;
  maxCommits: number;
  excerptChars: number;
  /** Pinned revision for the read; defaults to live HEAD when omitted. */
  rev?: string;
}

/** Bump to invalidate cached git reads. */
export const READ_CACHE_VERSION = 1;

export interface ReadCacheKeyParams {
  kind: "file-log" | "blame" | "symbol-log";
  head: string;
  file: string;
  lines?: [number, number];
  symbol?: string;
  maxCommits: number;
  excerptChars: number;
}

/** HEAD-keyed cache key for a git read: a read for a given HEAD never changes. */
export function readCacheKey(params: ReadCacheKeyParams): string {
  const canonical = JSON.stringify({
    kind: params.kind,
    head: params.head,
    file: params.file,
    lines: params.lines ?? null,
    symbol: params.symbol ?? null,
    maxCommits: params.maxCommits,
    excerptChars: params.excerptChars,
    version: READ_CACHE_VERSION,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface CommitRead {
  commits: ParsedLogCommit[];
  warning?: string;
}

export interface BlameRead {
  ranges: BlameRange[];
  shas: string[];
  warning?: string;
}

/** File log with `--follow -p`: whole-file history, renames included. */
export async function readFileLog(options: HistoryReadOptions): Promise<CommitRead> {
  const marker = newHistoryMarker();
  const rev = options.rev ?? "HEAD";
  const result = await runGit(options.repo, [
    "--literal-pathspecs",
    "log",
    "--follow",
    "-n",
    String(options.maxCommits),
    "-p",
    "--no-color",
    "--no-ext-diff",
    "-M",
    gitLogFormat(marker),
    rev,
    "--",
    options.file,
  ]);
  return { commits: parseLog(result.stdout, marker, options.excerptChars) };
}

function noHistoryMatch(stderr: string): boolean {
  return (
    stderr.includes("no match") || // -L parameter ... : no match
    /no such path .* in (HEAD|[0-9a-f]{4,40})/.test(stderr) || // path missing at pinned rev
    /There is no path .* in the commit/.test(stderr) || // -L file missing at HEAD
    /has only \d+ lines/.test(stderr) // -L past the end of the file
  );
}

/**
 * Symbol log: history of the function's lines. `-L` cannot take a pathspec
 * after `--`; the file is part of the `-L` argument (one argv element, never
 * parsed by a shell), so `-L` output is limited to that function. A symbol
 * with no match at HEAD (or a file missing at HEAD) is a warning, not an error.
 */
export async function readSymbolLog(
  options: HistoryReadOptions & { symbol: string },
): Promise<CommitRead> {
  const marker = newHistoryMarker();
  const rev = options.rev ?? "HEAD";
  try {
    const result = await runGit(options.repo, [
      "--literal-pathspecs",
      "log",
      "-n",
      String(options.maxCommits),
      "--no-color",
      "--no-ext-diff",
      gitLogFormat(marker),
      "-L",
      `:${escapeSymbol(options.symbol)}:${options.file}`,
      rev,
    ]);
    return { commits: parseLog(result.stdout, marker, options.excerptChars) };
  } catch (error) {
    if (error instanceof GitError && noHistoryMatch(error.stderr)) {
      return {
        commits: [],
        warning: `symbol log skipped for ${options.symbol} in ${options.file}: no match at HEAD`,
      };
    }
    throw error;
  }
}

/**
 * Blame a line range at HEAD. A path missing at HEAD or a range past the end
 * of the file is a warning, not an error; anything else throws GitError.
 */
export async function readBlame(
  repo: string,
  file: string,
  start: number,
  end: number,
  rev?: string,
): Promise<BlameRead> {
  try {
    const result = await runGit(repo, [
      "--literal-pathspecs",
      "blame",
      "--porcelain",
      "-L",
      `${start},${end}`,
      rev ?? "HEAD",
      "--",
      file,
    ]);
    const ranges = parseBlame(result.stdout);
    return { ranges, shas: [...new Set(ranges.map((r) => r.sha))] };
  } catch (error) {
    if (error instanceof GitError && noHistoryMatch(error.stderr)) {
      return {
        ranges: [],
        shas: [],
        warning: `blame skipped for ${file}: lines ${start},${end} have no history at HEAD`,
      };
    }
    throw error;
  }
}

/**
 * Read blame SHAs (full hex, validated by the caller) not seen in the other
 * reads. `--no-patch` keeps it cheap; these commits carry no diff.
 */
export async function readMissingCommits(
  repo: string,
  shas: string[],
): Promise<ParsedLogCommit[]> {
  if (shas.length === 0) {
    return [];
  }
  const marker = newHistoryMarker();
  const result = await runGit(repo, [
    "log",
    "--no-walk=unsorted",
    "--no-patch",
    gitLogFormat(marker),
    ...shas,
  ]);
  return parseLog(result.stdout, marker, 0);
}
