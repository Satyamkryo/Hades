import { closingIssueNumbers } from "../history/closing-issues.js";
import type { HistoryCommit } from "../ask/types.js";
import type { HistoryCache } from "../cache/store.js";
import type { GhIssue, GhPull, GhResult, GhReviewComment, GithubClient } from "./types.js";
import type { GithubTarget } from "./remote.js";

export interface CommitContext {
  pr?: GhPull;
  /** Always empty until the optional review-comments task is built. */
  reviewComments: GhReviewComment[];
  issues: GhIssue[];
  /** False when cut short by the budget, a rate limit or an error. */
  complete: boolean;
}

export interface GatherContextOptions {
  maxRequests: number;
  ttlMs: number;
  now: () => number;
}

export interface GatherContextResult {
  byCommit: Map<string, CommitContext>;
  requests: number;
  rateLimited: boolean;
  warnings: string[];
}

const MAX_ISSUES_PER_COMMIT = 3;

/** Cache `state` key remembering a rate limit across Questions. */
const RATE_LIMIT_UNTIL_KEY = "github-rate-limited-until";

function pullsKey(sha: string): string {
  return `pulls:${sha}`;
}

function issueKey(n: number): string {
  return `issue:${n}`;
}

function isGhResult(value: unknown): value is GhResult<never> {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    ((value as { ok: unknown }).ok === true || (value as { ok: unknown }).ok === false)
  );
}

/** Chosen PR: merged first, then the lowest number. */
function choosePull(pulls: GhPull[]): GhPull | undefined {
  return [...pulls].sort(
    (a, b) => Number(b.merged) - Number(a.merged) || a.number - b.number,
  )[0];
}

function emptyContext(): CommitContext {
  return { reviewComments: [], issues: [], complete: false };
}

/**
 * Fetch PR and issue context for history commits, in budget order: commits
 * found by blame or the symbol log first (newest first), then the rest
 * (newest first). `commits` must already be newest-first (mergeHistory order).
 * Requests run in sequence so the budget order is exact; cache hits are free.
 */
export async function gatherContext(
  commits: HistoryCommit[],
  target: GithubTarget,
  client: GithubClient,
  cache: HistoryCache,
  opts: GatherContextOptions,
): Promise<GatherContextResult> {
  const byCommit = new Map<string, CommitContext>();
  const warnings: string[] = [];
  const seenErrors = new Set<string>();
  let requests = 0;
  let rateLimited = false;
  let rateLimitReset: string | undefined;
  let outOfBudget = false;
  let unreached = 0;

  const warnError = (message: string): void => {
    if (!seenErrors.has(message)) {
      seenErrors.add(message);
      warnings.push(`GitHub request failed: ${message}`);
    }
  };

  const rememberRateLimit = (resetAt: string | undefined): void => {
    rateLimited = true;
    rateLimitReset = resetAt ?? new Date(opts.now() + 60_000).toISOString();
    cache.putState(RATE_LIMIT_UNTIL_KEY, rateLimitReset);
  };

  // A remembered rate limit skips network requests (cache hits still work)
  // until it passes, with the same warning as a fresh one.
  const rememberedUntil = cache.getState(RATE_LIMIT_UNTIL_KEY);
  if (rememberedUntil !== undefined) {
    if (Number.isFinite(Date.parse(rememberedUntil)) && opts.now() < Date.parse(rememberedUntil)) {
      rateLimited = true;
      rateLimitReset = rememberedUntil;
    }
  }

  const ordered = [
    ...commits.filter((c) => c.foundBy.includes("blame") || c.foundBy.includes("symbol-log")),
    ...commits.filter((c) => !c.foundBy.includes("blame") && !c.foundBy.includes("symbol-log")),
  ];

  /** Cached pulls, or whether a network request would be needed. */
  const cachedPulls = (
    sha: string,
  ): { state: "hit"; pulls: GhPull[] } | { state: "not-found" } | { state: "miss" } => {
    const cached = cache.getGithub(pullsKey(sha), opts.now(), opts.ttlMs);
    if (isGhResult(cached)) {
      return cached.ok
        ? { state: "hit", pulls: cached.data as GhPull[] }
        : { state: "not-found" };
    }
    return { state: "miss" };
  };

  const fetchPulls = async (sha: string): Promise<GhResult<GhPull[]> | "unreached"> => {
    const hit = cachedPulls(sha);
    if (hit.state === "hit") {
      return { ok: true, data: hit.pulls };
    }
    if (hit.state === "not-found") {
      return { ok: false, kind: "not-found" };
    }
    if (outOfBudget || rateLimited || requests >= opts.maxRequests) {
      return "unreached";
    }
    requests += 1;
    const result = await client.commitPulls(target, sha);
    if (result.ok || result.kind === "not-found") {
      cache.putGithub(pullsKey(sha), result, opts.now());
    }
    return result;
  };

  const fetchIssue = async (n: number): Promise<GhResult<GhIssue> | "unreached"> => {
    const cached = cache.getGithub(issueKey(n), opts.now(), opts.ttlMs);
    if (isGhResult(cached)) {
      return cached.ok
        ? { ok: true, data: cached.data as GhIssue }
        : { ok: false, kind: "not-found" };
    }
    if (outOfBudget || rateLimited || requests >= opts.maxRequests) {
      return "unreached";
    }
    requests += 1;
    const result = await client.issue(target, n);
    if (result.ok || result.kind === "not-found") {
      cache.putGithub(issueKey(n), result, opts.now());
    }
    return result;
  };

  const issueNumbers = (commit: HistoryCommit, pr: GhPull | undefined): number[] =>
    closingIssueNumbers(`${commit.message}\n${pr?.body ?? ""}`).slice(0, MAX_ISSUES_PER_COMMIT);

  /** Fill cacheable issues only; never spends budget. Used after a stop. */
  const contextFromCache = (
    commit: HistoryCommit,
    pulls: GhPull[],
  ): CommitContext => {
    const pr = choosePull(pulls);
    const issues: GhIssue[] = [];
    let complete = true;
    for (const n of issueNumbers(commit, pr)) {
      const cached = cache.getGithub(issueKey(n), opts.now(), opts.ttlMs);
      if (!isGhResult(cached)) {
        complete = false;
      } else if (cached.ok) {
        issues.push(cached.data as GhIssue);
      } else if (cached.kind !== "not-found") {
        complete = false;
      }
    }
    return { pr, reviewComments: [], issues, complete };
  };

  for (const commit of ordered) {
    if (outOfBudget || rateLimited) {
      const hit = cachedPulls(commit.sha);
      if (hit.state === "miss") {
        unreached += 1;
        byCommit.set(commit.sha, emptyContext());
      } else {
        byCommit.set(commit.sha, contextFromCache(commit, hit.state === "hit" ? hit.pulls : []));
      }
      continue;
    }
    const pullsResult = await fetchPulls(commit.sha);
    if (pullsResult === "unreached") {
      outOfBudget = true;
      unreached += 1;
      byCommit.set(commit.sha, emptyContext());
      continue;
    }
    if (!pullsResult.ok && pullsResult.kind !== "not-found") {
      if (pullsResult.kind === "rate-limited") {
        rememberRateLimit(pullsResult.resetAt);
        unreached += 1;
        byCommit.set(commit.sha, emptyContext());
        continue;
      }
      warnError(pullsResult.message);
      byCommit.set(commit.sha, emptyContext());
      continue;
    }
    // A 404 means no PRs, not missing context: issues still come from the message.
    const pr = pullsResult.ok ? choosePull(pullsResult.data) : undefined;
    const issues: GhIssue[] = [];
    let complete = true;
    let stopped: "budget" | "rate-limit" | undefined;
    for (const n of issueNumbers(commit, pr)) {
      const issue = await fetchIssue(n);
      if (issue === "unreached") {
        complete = false;
        stopped = rateLimited ? "rate-limit" : "budget";
        continue;
      }
      if (!issue.ok) {
        if (issue.kind === "rate-limited") {
          rememberRateLimit(issue.resetAt);
          complete = false;
          stopped = "rate-limit";
          continue;
        }
        if (issue.kind === "error") {
          warnError(issue.message);
          complete = false;
          break;
        }
        continue;
      }
      issues.push(issue.data);
    }
    if (!complete && stopped === "budget") {
      outOfBudget = true;
    }
    if (!complete && stopped !== undefined) {
      unreached += 1;
    }
    byCommit.set(commit.sha, { pr, reviewComments: [], issues, complete });
  }

  if (rateLimited) {
    warnings.push(
      rateLimitReset === undefined
        ? "GitHub rate limit reached"
        : `GitHub rate limit reached (resets at ${rateLimitReset})`,
    );
  } else if (outOfBudget && unreached > 0) {
    warnings.push(`GitHub request budget reached; ${unreached} commits have no GitHub context`);
  }
  return { byCommit, requests, rateLimited, warnings };
}
