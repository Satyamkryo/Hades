import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Echo } from "../src/ask/types.js";
import { repoId } from "../src/cache/repo-id.js";
import { openCache } from "../src/cache/store.js";

const tempDirs: string[] = [];

function makeTemp(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function echoFor(sha: string, text: string): Echo {
  return {
    sha,
    issueNumbers: [],
    confidence: "said",
    text,
    source: { kind: "commit-message", ref: sha },
  };
}

describe("repoId", () => {
  it("is stable and 16 hex chars", () => {
    const repo = makeTemp("hades-repo-");
    expect(repoId(repo)).toBe(repoId(repo));
    expect(repoId(repo)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("folds case on Windows", () => {
    const repo = makeTemp("hades-repo-");
    const folded = repoId(repo) === repoId(repo.toLowerCase());
    if (process.platform === "win32") {
      expect(folded).toBe(true);
    } else {
      expect(typeof folded).toBe("boolean");
    }
  });
});

describe("openCache", () => {
  it("stores the database in a temp hades home", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const { cache, warning } = openCache(repo, { hadesHome: home });
    try {
      expect(warning).toBeUndefined();
      expect(existsSync(path.join(home, `${repoId(repo)}.db`))).toBe(true);
      expect(cache.warnings()).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("refuses a database path inside the repo", () => {
    const repo = makeTemp("hades-repo-");
    const home = path.join(repo, "nested-home");
    const { cache, warning } = openCache(repo, {
      hadesHome: home,
    });
    try {
      expect(warning).toContain("inside the repo");
      expect(warning?.startsWith("cache:")).toBe(true);
      expect(existsSync(home)).toBe(false);
      cache.putState("k", "v");
      expect(cache.getState("k")).toBeUndefined();
      expect(cache.warnings()).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("rounds-trips commits, reads and state", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const { cache } = openCache(repo, { hadesHome: home });
    try {
      const sha = "a".repeat(40);
      cache.putCommits([{ sha, message: "m", author: "a", date: "d", ct: 7 }]);
      expect(cache.getCommit(sha)).toMatchObject({ sha, ct: 7 });
      expect(cache.getCommit("b".repeat(40))).toBeUndefined();
      cache.putRead("read-key", { commits: [1] });
      expect(cache.getRead("read-key")).toEqual({ commits: [1] });
      cache.putState("s", "v");
      expect(cache.getState("s")).toBe("v");
      expect(cache.getState("missing")).toBeUndefined();
      expect(cache.warnings()).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("expires github rows after the TTL", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const { cache } = openCache(repo, { hadesHome: home });
    try {
      cache.putGithub("pulls:abc", [{ n: 1 }], 1000);
      expect(cache.getGithub("pulls:abc", 1000 + 999, 1000)).toEqual([{ n: 1 }]);
      expect(cache.getGithub("pulls:abc", 1000 + 1000, 1000)).toBeUndefined();
      expect(cache.getGithub("absent", 1000, 1000)).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it("overwrites an echo when the input key changes", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const sha = "c".repeat(40);
    const { cache } = openCache(repo, { hadesHome: home });
    try {
      cache.putEcho(sha, "key-1", echoFor(sha, "first"));
      expect(cache.getEcho(sha, "key-1")?.text).toBe("first");
      cache.putEcho(sha, "key-2", echoFor(sha, "second"));
      expect(cache.getEcho(sha, "key-1")).toBeUndefined();
      expect(cache.getEcho(sha, "key-2")?.text).toBe("second");
    } finally {
      cache.close();
    }
  });

  it("recreates tables on a version bump", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const sha = "d".repeat(40);
    const first = openCache(repo, { hadesHome: home });
    first.cache.putCommits([{ sha, message: "m", author: "a", date: "d", ct: 1 }]);
    expect(first.cache.getCommit(sha)).toMatchObject({ sha });
    first.cache.close();

    const dbPath = path.join(home, `${repoId(repo)}.db`);
    const raw = new Database(dbPath);
    try {
      raw.pragma("user_version = 2");
    } finally {
      raw.close();
    }

    const second = openCache(repo, { hadesHome: home });
    try {
      expect(second.warning).toBeUndefined();
      expect(second.cache.getCommit(sha)).toBeUndefined();
      second.cache.putState("s", "v");
      expect(second.cache.getState("s")).toBe("v");
    } finally {
      second.cache.close();
    }
  });

  it("gives a no-op cache and a warning for a corrupt file", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const dbPath = path.join(home, `${repoId(repo)}.db`);
    writeFileSync(dbPath, "not a database");
    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    const { cache, warning } = openCache(repo, { hadesHome: home });
    try {
      expect(warning?.startsWith("cache:")).toBe(true);
      cache.putState("k", "v");
      expect(cache.getState("k")).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it("goes no-op with one warning after a failure", () => {
    const repo = makeTemp("hades-repo-");
    const home = makeTemp("hades-home-");
    const { cache } = openCache(repo, { hadesHome: home });
    cache.close();
    expect(cache.getState("k")).toBeUndefined();
    expect(cache.warnings().filter((w) => w.startsWith("cache:"))).toHaveLength(1);
    expect(cache.getState("k")).toBeUndefined();
    expect(cache.warnings().filter((w) => w.startsWith("cache:"))).toHaveLength(1);
  });
});
