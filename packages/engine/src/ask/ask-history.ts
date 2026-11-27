import { join } from "node:path";
import { homedir } from "node:os";
import { redact } from "../report/redact.js";
import { existingCommits } from "../git/verify-shas.js";
import { validateRepo } from "../repo/validate.js";
import { openCache, type HistoryCache, type CommitMeta } from "../cache/store.js";
import { buildEchoes } from "../echo/build.js";
import type { CommitContext } from "../github/context.js";
import { gatherContext } from "../github/context.js";
import { createGithubClient } from "../github/client.js";
import type { GithubClient } from "../github/types.js";
import { readGithubTarget } from "../github/remote.js";
import type { LlmClient } from "../llm/types.js";
import {
  readBlame,
  readCacheKey,
  readFileLog,
  readMissingCommits,
  readSymbolLog,
} from "./git-reads.js";
import { mergeHistory } from "./merge.js";
import { normalizeTargetFile, resolveAskOptions } from "./options.js";
import type { AskHistoryOptions } from "./options.js";
import type { ParsedLogCommit } from "./parse-log.js";
import type { BlameRange, HistoryAnswer, HistoryCommit } from "./types.js";

export interface HistoryDeps {
  github?: GithubClient | null;
  llm?: LlmClient | null;
  llmModel?: string;
  hadesHome?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export type { AskHistoryOptions };

interface CachedCommitRead {
  commits: ParsedLogCommit[];
  warning?: string;
}

interface CachedBlameRead {
  ranges: BlameRange[];
  shas: string[];
  warning?: string;
}

function isCommitRead(value: unknown): value is CachedCommitRead {
  return typeof value === "object" && value !== null && Array.isArray((value as { commits?: unknown }).commits);
}

function isBlameRead(value: unknown): value is CachedBlameRead {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { ranges?: unknown }).ranges) &&
    Array.isArray((value as { shas?: unknown }).shas)
  );
}

function toMeta(commit: ParsedLogCommit): CommitMeta {
  return {
    sha: commit.sha,
    message: commit.message,
    author: commit.author,
    date: commit.date,
    ct: commit.committerTime,
  };
}

function fromMeta(meta: CommitMeta): ParsedLogCommit {
  return {
    sha: meta.sha,
    message: meta.message,
    author: meta.author,
    date: meta.date,
    diff: "",
    diffTruncated: false,
    foundBy: [],
    committerTime: meta.ct,
  };
}

/**
 * Answer "what does history say about this file?": the commits that touched a
 * file, line range or symbol, one echo per commit, and warnings. Read-only:
 * git and GitHub are only read, and the only file written is the cache at
 * `<hadesHome>/<repo-id>.db`.
 */
export async function askHistory(
  repo: string,
  file: string,
  options: AskHistoryOptions = {},
  deps: HistoryDeps = {},
): Promise<HistoryAnswer> {
  const env = deps.env ?? process.env;
  const token = env["GITHUB_TOKEN"];
  const apiKey = env["HADES_LLM_API_KEY"];
  const safe = (text: string): string => redact(redact(text, token), apiKey);
  try {
    const answer = await askHistoryInner(repo, file, options, deps, env);
    return { ...answer, warnings: answer.warnings.map(safe) };
  } catch (error) {
    if (error instanceof Error) {
      error.message = safe(error.message);
    }
    throw error;
  }
}

async function askHistoryInner(
  repo: string,
  file: string,
  options: AskHistoryOptions,
  deps: HistoryDeps,
  env: NodeJS.ProcessEnv,
): Promise<HistoryAnswer> {
  const resolved = resolveAskOptions(options);
  const validated = await validateRepo(repo);
  const repoRoot = validated.repo;
  const head = validated.baseSha ?? null;
  const targetFile = normalizeTargetFile(repoRoot, file);
  const base = {
    repo: repoRoot,
    file: targetFile,
    ...(resolved.lines !== undefined ? { lines: resolved.lines } : {}),
    ...(resolved.symbol !== undefined ? { symbol: resolved.symbol } : {}),
  };

  const { cache, warning: cacheWarning } = openCache(repoRoot, {
    hadesHome: deps.hadesHome ?? join(homedir(), ".hades"),
  });
  const warnings: string[] = [];
  if (cacheWarning !== undefined) {
    warnings.push(cacheWarning);
  }
  try {
    if (head === null) {
      return { ...base, headSha: null, github: { mode: "local" }, blame: [], commits: [], echoes: [], warnings };
    }

    const readOpts = {
      repo: repoRoot,
      file: targetFile,
      maxCommits: resolved.maxCommits,
      excerptChars: resolved.excerptChars,
      rev: head,
    };

    const fileRead = await cachedFileRead(cache, readOpts, head, "file-log");
    if (fileRead.warning !== undefined) {
      warnings.push(fileRead.warning);
    }

    let blameRanges: BlameRange[] = [];
    let blameShas: string[] = [];
    if (resolved.lines !== undefined) {
      const [start, end] = resolved.lines;
      const blameKey = readCacheKey({
        kind: "blame",
        head,
        file: targetFile,
        lines: [start, end],
        maxCommits: resolved.maxCommits,
        excerptChars: resolved.excerptChars,
      });
      let blame: CachedBlameRead;
      const cachedBlame = cache.getRead(blameKey);
      if (isBlameRead(cachedBlame)) {
        blame = cachedBlame;
      } else {
        const read = await readBlame(repoRoot, targetFile, start, end, head);
        blame = { ranges: read.ranges, shas: read.shas, warning: read.warning };
        cache.putRead(blameKey, blame);
      }
      if (blame.warning !== undefined) {
        warnings.push(blame.warning);
      }
      blameRanges = blame.ranges;
      blameShas = blame.shas;
    }

    let symbolCommits: ParsedLogCommit[] = [];
    if (resolved.symbol !== undefined) {
      const symbolKey = readCacheKey({
        kind: "symbol-log",
        head,
        file: targetFile,
        symbol: resolved.symbol,
        maxCommits: resolved.maxCommits,
        excerptChars: resolved.excerptChars,
      });
      let symbol: CachedCommitRead;
      const cachedSymbol = cache.getRead(symbolKey);
      if (isCommitRead(cachedSymbol)) {
        symbol = cachedSymbol;
      } else {
        const read = await readSymbolLog({ ...readOpts, symbol: resolved.symbol });
        symbol = { commits: read.commits, warning: read.warning };
        cache.putRead(symbolKey, symbol);
      }
      if (symbol.warning !== undefined) {
        warnings.push(symbol.warning);
      }
      symbolCommits = symbol.commits;
    }

    cache.putCommits(fileRead.commits.map(toMeta));
    cache.putCommits(symbolCommits.map(toMeta));
    const blameOnly: ParsedLogCommit[] = [];
    const uncached: string[] = [];
    for (const sha of blameShas) {
      const meta = cache.getCommit(sha);
      if (meta === undefined) {
        uncached.push(sha);
      } else {
        blameOnly.push(fromMeta(meta));
      }
    }
    if (uncached.length > 0) {
      const fetched = await readMissingCommits(repoRoot, uncached);
      cache.putCommits(fetched.map(toMeta));
      blameOnly.push(...fetched);
    }

    const commits: HistoryCommit[] = mergeHistory({
      fileLog: fileRead.commits,
      symbolLog: symbolCommits,
      blame: blameOnly,
    });

    let github: HistoryAnswer["github"] = { mode: "local" };
    let contexts = new Map<string, CommitContext>();
    const target = await readGithubTarget(repoRoot);
    if (target !== undefined) {
      const repoName = `${target.owner}/${target.repo}`;
      const client =
        deps.github !== undefined
          ? deps.github
          : createGithubClient({ token: env["GITHUB_TOKEN"], timeoutMs: resolved.githubTimeoutMs });
      if (client === null || resolved.maxGithubRequests === 0) {
        github = { mode: "github", repo: repoName, disabled: true, requests: 0, rateLimited: false };
      } else {
        const context = await gatherContext(commits, target, client, cache, {
          maxRequests: resolved.maxGithubRequests,
          ttlMs: resolved.githubTtlMs,
          now: deps.now ?? Date.now,
        });
        contexts = context.byCommit;
        github = { mode: "github", repo: repoName, requests: context.requests, rateLimited: context.rateLimited };
        warnings.push(...context.warnings);
      }
    }

    const built = await buildEchoes(
      commits.map((commit) => ({ commit, context: contexts.get(commit.sha) })),
      target,
      cache,
      { llm: deps.llm, llmModel: deps.llmModel, env },
      { maxLlmChecks: resolved.maxLlmChecks },
    );
    warnings.push(...built.warnings);

    const existing = await existingCommits(repoRoot, [
      ...commits.map((c) => c.sha),
      ...blameRanges.map((r) => r.sha),
    ]);
    const kept = commits.filter((c) => existing.has(c.sha));
    const keptShas = new Set(kept.map((c) => c.sha));
    if (kept.length !== commits.length) {
      warnings.push(`dropped ${commits.length - kept.length} commits not found in the repo`);
    }
    return {
      ...base,
      headSha: head,
      github,
      blame: blameRanges.filter((r) => existing.has(r.sha)),
      commits: kept,
      echoes: built.echoes.filter((e) => keptShas.has(e.sha)),
      warnings,
    };
  } finally {
    cache.close();
  }
}

async function cachedFileRead(
  cache: HistoryCache,
  readOpts: { repo: string; file: string; maxCommits: number; excerptChars: number; rev?: string },
  head: string,
  kind: "file-log",
): Promise<CachedCommitRead> {
  const key = readCacheKey({
    kind,
    head,
    file: readOpts.file,
    maxCommits: readOpts.maxCommits,
    excerptChars: readOpts.excerptChars,
  });
  const cached = cache.getRead(key);
  if (isCommitRead(cached)) {
    return cached;
  }
  const read = await readFileLog(readOpts);
  const value: CachedCommitRead = { commits: read.commits, warning: read.warning };
  cache.putRead(key, value);
  return value;
}
