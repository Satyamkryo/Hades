import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config.js";
import type { SummonEntry } from "../src/report/types.js";
import { commitExists, verifyAndTotal, type UnverifiedReport } from "../src/report/verify.js";
import { git, makeRepo } from "./helpers/repo.js";

const repo = makeRepo([
  { message: "one", files: { "a.txt": "1" } },
  { message: "two", files: { "a.txt": "2" } },
]);
afterAll(() => repo.cleanup());

const [sha1, sha2] = repo.shas as [string, string];
const FAKE = "0123456789abcdef0123456789abcdef01234567";

function entry(sha: string, label: SummonEntry["label"]): SummonEntry {
  return {
    sha,
    message: "m",
    matchedRules: ["keyword"],
    llmReason: "r",
    filesReverted: ["a.txt"],
    label,
    testOutputExcerpt: "",
    durationMs: 1,
    runs: 1,
  };
}

function base(over: Partial<UnverifiedReport> = {}): UnverifiedReport {
  return {
    status: "ok",
    repo: repo.dir,
    baseSha: sha2,
    options: resolveOptions(),
    deps: { method: "none", workspace: false },
    warnings: [],
    entries: [],
    unguarded: [],
    rejected: [],
    llmErrors: [],
    ...over,
  };
}

const phase = {
  commitsScanned: 5,
  candidates: 4,
  rejectedByLlm: 1,
  llmErrors: 1,
  unchecked: 2,
  staleCleaned: 0,
};

describe("commitExists", () => {
  it("accepts real commits and rejects fakes, short and malformed SHAs", async () => {
    expect(await commitExists(repo.dir, sha1)).toBe(true);
    expect(await commitExists(repo.dir, FAKE)).toBe(false);
    expect(await commitExists(repo.dir, sha1.slice(0, 7))).toBe(false);
    expect(await commitExists(repo.dir, "--help")).toBe(false);
  });

  it("rejects an annotated tag and accepts its target commit", async () => {
    git(repo.dir, "tag", "-a", "verify-tag", "-m", "tag message", sha1);
    const tagSha = git(repo.dir, "rev-parse", "verify-tag").trim();
    expect(await commitExists(repo.dir, tagSha)).toBe(false);
    expect(await commitExists(repo.dir, sha1)).toBe(true);
  });
});

describe("verifyAndTotal", () => {
  it("derives totals from entries and the unguarded list, and passes phase totals through", async () => {
    const report = await verifyAndTotal(
      repo.dir,
      base({
        entries: [entry(sha1, "escaped"), entry(sha2, "buried"), entry(sha1, "lost"), entry(sha2, "escaped")],
        unguarded: [{ sha: sha1, message: "m", matchedRules: [], llmReason: "r", files: ["a.txt"] }],
      }),
      phase,
    );
    expect(report.totals).toMatchObject({
      ...phase,
      processed: 4,
      escaped: 2,
      buried: 1,
      lost: 1,
      unguarded: 1,
    });
    expect(report.droppedUnverified).toEqual([]);
  });

  it("drops items with nonexistent SHAs from every list and lists them", async () => {
    const note = { message: "m", reason: "r" };
    const report = await verifyAndTotal(
      repo.dir,
      base({
        entries: [entry(sha1, "escaped"), entry(FAKE, "escaped")],
        rejected: [{ sha: FAKE, ...note }, { sha: sha2, ...note }],
        llmErrors: [{ sha: FAKE, ...note }],
        unguarded: [{ sha: FAKE, message: "m", matchedRules: [], llmReason: "r", files: [] }],
      }),
      phase,
    );
    expect(report.entries.map((e) => e.sha)).toEqual([sha1]);
    expect(report.rejected.map((r) => r.sha)).toEqual([sha2]);
    expect(report.llmErrors).toEqual([]);
    expect(report.unguarded).toEqual([]);
    expect(report.droppedUnverified).toEqual([FAKE, FAKE, FAKE, FAKE]);
    expect(report.totals.processed).toBe(1);
    expect(report.totals.escaped).toBe(1);
    expect(report.totals.unguarded).toBe(0);
  });

  it("lists an unverifiable baseSha and warns", async () => {
    const report = await verifyAndTotal(repo.dir, base({ baseSha: FAKE }), phase);
    expect(report.droppedUnverified).toEqual([FAKE]);
    expect(report.warnings.join(" ")).toContain(FAKE);
  });

  it("property: totals always match the verified entries", async () => {
    const labels = fc.constantFrom("escaped", "buried", "lost" as const);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(sha1, sha2, FAKE), labels), { maxLength: 8 }),
        async (items) => {
          const entries = items.map(([s, l]) => entry(s, l as SummonEntry["label"]));
          const report = await verifyAndTotal(repo.dir, base({ entries }), phase);
          const t = report.totals;
          expect(t.processed).toBe(report.entries.length);
          expect(t.escaped + t.buried + t.lost).toBe(t.processed);
          expect(report.entries.every((e) => e.sha !== FAKE)).toBe(true);
          expect(report.droppedUnverified.length).toBe(items.filter(([s]) => s === FAKE).length);
        },
      ),
      { numRuns: 20 },
    );
  });
});
