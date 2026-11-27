import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FoundBy, HistoryCommit } from "../src/ask/types.js";
import { openCache } from "../src/cache/store.js";
import { gatherContext } from "../src/github/context.js";
import type { GhIssue, GhPull } from "../src/github/types.js";
import { createFakeGithub } from "./helpers/fake-github.js";

const TARGET = { owner: "octo", repo: "lib" };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function commit(sha: string, message: string, foundBy: FoundBy[]): HistoryCommit {
  return {
    sha,
    message,
    author: "a",
    date: "2024-01-01T00:00:00+00:00",
    diff: "",
    diffTruncated: false,
    foundBy,
  };
}

function pull(number: number, merged: boolean, body: string): GhPull {
  return { number, url: `https://github.com/octo/lib/pull/${number}`, merged, body };
}

function issue(n: number): GhIssue {
  return { number: n, url: `https://github.com/octo/lib/issues/${n}`, body: `issue ${n}` };
}

// Newest first: C3 (file-log), C2 (blame), C1 (file-log).
function commits(): HistoryCommit[] {
  return [
    commit(C3, "tweak", ["file-log"]),
    commit(C2, "fix crash fixes #12", ["blame"]),
    commit(C1, "init", ["file-log"]),
  ];
}

describe("gatherContext", () => {
  it("queries blame commits first and picks merged then lowest PRs with 3 issues", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const fake = createFakeGithub({
        pulls: {
          [C2]: [pull(9, false, "unrelated"), pull(5, true, "also closes #13 and fixes #14\ncloses #15, fixes #16")],
          [C3]: [pull(7, false, "wip"), pull(3, false, "wip")],
        },
        comments: {},
        issues: { 12: issue(12), 13: issue(13), 14: issue(14), 15: issue(15) },
      });
      const result = await gatherContext(commits(), TARGET, fake.client, cache, {
        maxRequests: 30,
        ttlMs: 86_400_000,
        now: () => 1_000_000,
      });

      expect(fake.calls.pulls.map((c) => c.sha)).toEqual([C2, C3, C1]);
      expect(fake.calls.issues.map((c) => c.n)).toEqual([12, 13, 14]);
      expect(result.requests).toBe(6);
      expect(result.rateLimited).toBe(false);
      expect(result.warnings).toEqual([]);

      const c2 = result.byCommit.get(C2);
      expect(c2?.pr?.number).toBe(5);
      expect(c2?.issues.map((i) => i.number)).toEqual([12, 13, 14]);
      expect(c2?.complete).toBe(true);

      const c3 = result.byCommit.get(C3);
      expect(c3?.pr?.number).toBe(3);
      expect(c3?.issues).toEqual([]);
      expect(c3?.complete).toBe(true);

      const c1 = result.byCommit.get(C1);
      expect(c1?.pr).toBeUndefined();
      expect(c1?.complete).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("still fetches message-linked issues when the commit has no PRs", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const fake = createFakeGithub({
        pulls: {},
        comments: {},
        issues: { 12: issue(12) },
      });
      const result = await gatherContext(
        [commit(C2, "fix crash fixes #12", ["file-log"])],
        TARGET,
        fake.client,
        cache,
        { maxRequests: 30, ttlMs: 86_400_000, now: () => 1_000_000 },
      );
      expect(result.requests).toBe(2);
      const ctx = result.byCommit.get(C2);
      expect(ctx?.pr).toBeUndefined();
      expect(ctx?.issues.map((i) => i.number)).toEqual([12]);
      expect(ctx?.complete).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("stops at the budget with one summary warning", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const fake = createFakeGithub({
        pulls: { [C2]: [pull(5, true, "fixes #12")] },
        comments: {},
        issues: { 12: issue(12) },
      });
      const result = await gatherContext(commits(), TARGET, fake.client, cache, {
        maxRequests: 2,
        ttlMs: 86_400_000,
        now: () => 1_000_000,
      });
      expect(result.requests).toBe(2);
      expect(result.warnings).toEqual([
        "GitHub request budget reached; 2 commits have no GitHub context",
      ]);
      expect(result.byCommit.get(C2)?.complete).toBe(true);
      for (const sha of [C1, C3]) {
        expect(result.byCommit.get(sha)?.complete).toBe(false);
      }
    } finally {
      cache.close();
    }
  });

  it("uses a warm cache to reach further on the next Question", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    const opts = { maxRequests: 3, ttlMs: 86_400_000, now: () => 1_000_000 };
    try {
      const fake = createFakeGithub({
        pulls: { [C2]: [pull(5, true, "fixes #12")] },
        comments: {},
        issues: { 12: issue(12) },
      });
      const cold = await gatherContext(commits(), TARGET, fake.client, cache, opts);
      expect(cold.requests).toBe(3);
      expect(cold.byCommit.get(C2)?.complete).toBe(true);
      expect(cold.byCommit.get(C1)?.complete).toBe(false);

      const warm = await gatherContext(commits(), TARGET, fake.client, cache, opts);
      expect(warm.requests).toBe(1);
      expect(warm.warnings).toEqual([]);
      for (const sha of [C1, C2, C3]) {
        expect(warm.byCommit.get(sha)?.complete).toBe(true);
      }
      expect(warm.byCommit.get(C2)?.issues.map((i) => i.number)).toEqual([12]);
    } finally {
      cache.close();
    }
  });

  it("stops on a rate limit without further requests", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const fake = createFakeGithub(
        { pulls: {}, comments: {}, issues: {} },
        { pulls: { [C2]: "rate-limited" } },
      );
      const result = await gatherContext(commits(), TARGET, fake.client, cache, {
        maxRequests: 30,
        ttlMs: 86_400_000,
        now: () => 1_000_000,
      });
      expect(result.rateLimited).toBe(true);
      expect(result.requests).toBe(1);
      expect(fake.calls.pulls).toHaveLength(1);
      expect(result.warnings).toEqual([
        `GitHub rate limit reached (resets at ${new Date(1_060_000).toISOString()})`,
      ]);
    } finally {
      cache.close();
    }
  });

  it("reports the rate-limit reset time when given", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const client = {
        commitPulls: () =>
          Promise.resolve({
            ok: false as const,
            kind: "rate-limited" as const,
            resetAt: "2030-01-01T00:00:00.000Z",
          }),
        reviewComments: () => Promise.resolve({ ok: true as const, data: [] }),
        issue: () => Promise.resolve({ ok: false as const, kind: "not-found" as const }),
      };
      const result = await gatherContext(commits(), TARGET, client, cache, {
        maxRequests: 30,
        ttlMs: 86_400_000,
        now: () => 1_000_000,
      });
      expect(result.warnings).toEqual([
        "GitHub rate limit reached (resets at 2030-01-01T00:00:00.000Z)",
      ]);
    } finally {
      cache.close();
    }
  });

  it("marks cached context incomplete when referenced issues are missing", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    const nowMs = 1_000_000;
    try {
      cache.putState("github-rate-limited-until", new Date(nowMs + 60_000).toISOString());
      cache.putGithub(
        `pulls:${C2}`,
        { ok: true, data: [pull(5, true, "fixes #13")] },
        nowMs,
      );
      const cachedNotFound = await gatherContext(
        [commit(C2, "fix crash fixes #12", ["blame"])], TARGET,
        createFakeGithub({ pulls: {}, comments: {}, issues: {} }).client, cache,
        { maxRequests: 30, ttlMs: 86_400_000, now: () => nowMs },
      );
      expect(cachedNotFound.byCommit.get(C2)?.complete).toBe(false);

      cache.putGithub("issue:12", { ok: false, kind: "not-found" }, nowMs);
      cache.putGithub("issue:13", { ok: true, data: issue(13) }, nowMs);
      const cachedMiss = await gatherContext(
        [commit(C2, "fix crash fixes #12", ["blame"])], TARGET,
        createFakeGithub({ pulls: {}, comments: {}, issues: {} }).client, cache,
        { maxRequests: 30, ttlMs: 86_400_000, now: () => nowMs },
      );
      expect(cachedMiss.requests).toBe(0);
      expect(cachedMiss.byCommit.get(C2)?.complete).toBe(true);
      expect(cachedMiss.byCommit.get(C2)?.issues.map((entry) => entry.number)).toEqual([13]);
    } finally {
      cache.close();
    }
  });

  it("keeps cached issues after the request budget is exhausted", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      cache.putGithub("issue:13", { ok: true, data: issue(13) }, 1_000_000);
      cache.putGithub("issue:14", { ok: true, data: issue(14) }, 1_000_000);
      const fake = createFakeGithub({
        pulls: { [C2]: [pull(5, true, "fixes #12; fixes #13; fixes #14")] },
        comments: {},
        issues: {},
      });
      const result = await gatherContext(
        [commit(C2, "fix crash", ["blame"])], TARGET, fake.client, cache,
        { maxRequests: 1, ttlMs: 86_400_000, now: () => 1_000_000 },
      );
      expect(result.requests).toBe(1);
      expect(result.byCommit.get(C2)?.issues.map((entry) => entry.number)).toEqual([13, 14]);
      expect(result.byCommit.get(C2)?.complete).toBe(false);
      expect(fake.calls.issues).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("deduplicates error warnings and does not cache errors", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    const opts = { maxRequests: 30, ttlMs: 86_400_000, now: () => 1_000_000 };
    try {
      const fake = createFakeGithub(
        { pulls: {}, comments: {}, issues: {} },
        { pulls: { [C2]: { error: "boom" }, [C3]: { error: "boom" } } },
      );
      const first = await gatherContext(commits(), TARGET, fake.client, cache, opts);
      expect(first.warnings).toEqual(["GitHub request failed: boom"]);
      expect(first.byCommit.get(C2)?.complete).toBe(false);
      expect(first.byCommit.get(C3)?.complete).toBe(false);
      expect(fake.calls.pulls.filter((c) => c.sha === C2)).toHaveLength(1);

      // Error answers are not cached: the same SHAs are requested again.
      const second = await gatherContext(commits(), TARGET, fake.client, cache, opts);
      expect(second.warnings).toEqual(["GitHub request failed: boom"]);
      expect(fake.calls.pulls.filter((c) => c.sha === C2)).toHaveLength(2);
      expect(fake.calls.pulls.filter((c) => c.sha === C3)).toHaveLength(2);
    } finally {
      cache.close();
    }
  });

  it("serves cached answers until the TTL expires", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    let nowMs = 1_000_000;
    const opts = { maxRequests: 30, ttlMs: 1000, now: () => nowMs };
    try {
      const fake = createFakeGithub({
        pulls: { [C2]: [pull(5, true, "fixes #12")] },
        comments: {},
        issues: { 12: issue(12) },
      });
      const first = await gatherContext([commits()[1]!], TARGET, fake.client, cache, opts);
      expect(first.requests).toBe(2);

      nowMs += 999;
      const warm = await gatherContext([commits()[1]!], TARGET, fake.client, cache, opts);
      expect(warm.requests).toBe(0);
      expect(warm.byCommit.get(C2)?.complete).toBe(true);

      nowMs += 1;
      const expired = await gatherContext([commits()[1]!], TARGET, fake.client, cache, opts);
      expect(expired.requests).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("remembers a rate limit across Questions until it passes", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    let nowMs = 1_000_000;
    const opts = () => ({ maxRequests: 30, ttlMs: 86_400_000, now: () => nowMs });
    const resetAt = new Date(nowMs + 60_000).toISOString();
    let calls = 0;
    const client = {
      commitPulls: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? { ok: false as const, kind: "rate-limited" as const, resetAt }
            : { ok: true as const, data: [] },
        );
      },
      reviewComments: () => Promise.resolve({ ok: true as const, data: [] }),
      issue: () => Promise.resolve({ ok: false as const, kind: "not-found" as const }),
    };
    try {
      const first = await gatherContext(commits(), TARGET, client, cache, opts());
      expect(first.rateLimited).toBe(true);
      expect(first.requests).toBe(1);
      expect(first.warnings).toEqual([`GitHub rate limit reached (resets at ${resetAt})`]);
      expect(cache.getState("github-rate-limited-until")).toBe(resetAt);

      const second = await gatherContext(commits(), TARGET, client, cache, opts());
      expect(second.requests).toBe(0);
      expect(calls).toBe(1);
      expect(second.rateLimited).toBe(true);
      expect(second.warnings).toEqual([`GitHub rate limit reached (resets at ${resetAt})`]);
      for (const sha of [C1, C2, C3]) {
        expect(second.byCommit.get(sha)?.complete).toBe(false);
      }

      nowMs += 61_000;
      const third = await gatherContext(commits(), TARGET, client, cache, opts());
      expect(third.rateLimited).toBe(false);
      expect(third.warnings).toEqual([]);
      expect(calls).toBeGreaterThan(1);
      for (const sha of [C1, C2, C3]) {
        expect(third.byCommit.get(sha)?.complete).toBe(true);
      }
    } finally {
      cache.close();
    }
  });

  it("remembers a rate limit for at least one minute without a reset time", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    const opts = { maxRequests: 30, ttlMs: 86_400_000, now: () => 1_000_000 };
    let calls = 0;
    const client = {
      commitPulls: () => {
        calls += 1;
        return Promise.resolve({ ok: false as const, kind: "rate-limited" as const });
      },
      reviewComments: () => Promise.resolve({ ok: true as const, data: [] }),
      issue: () => Promise.resolve({ ok: false as const, kind: "not-found" as const }),
    };
    try {
      const first = await gatherContext(commits(), TARGET, client, cache, opts);
      const fallbackResetAt = new Date(opts.now() + 60_000).toISOString();
      expect(first.warnings).toEqual([`GitHub rate limit reached (resets at ${fallbackResetAt})`]);
      expect(Date.parse(cache.getState("github-rate-limited-until") ?? "")).toBeGreaterThanOrEqual(
        opts.now() + 60_000,
      );
      const second = await gatherContext(commits(), TARGET, client, cache, opts);
      expect(second.rateLimited).toBe(true);
      expect(second.requests).toBe(0);
      expect(calls).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("stops the run on an issue rate limit", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const fake = createFakeGithub(
        {
          pulls: { [C2]: [pull(5, true, "fixes #12")] },
          comments: {},
          issues: { 12: issue(12) },
        },
        { issues: { 12: "rate-limited" } },
      );
      const result = await gatherContext(commits(), TARGET, fake.client, cache, {
        maxRequests: 30,
        ttlMs: 86_400_000,
        now: () => 1_000_000,
      });
      expect(result.rateLimited).toBe(true);
      expect(result.warnings).toEqual([
        `GitHub rate limit reached (resets at ${new Date(1_060_000).toISOString()})`,
      ]);
      expect(result.requests).toBe(2);
      expect(fake.calls.issues.map((c) => c.n)).toEqual([12]);
      expect(fake.calls.pulls.map((c) => c.sha)).toEqual([C2]);
      expect(result.byCommit.get(C2)?.complete).toBe(false);
    } finally {
      cache.close();
    }
  });
});
