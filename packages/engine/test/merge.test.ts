import { describe, expect, it } from "vitest";
import { mergeHistory } from "../src/ask/merge.js";
import type { ParsedLogCommit } from "../src/ask/parse-log.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function commit(sha: string, overrides: Partial<ParsedLogCommit> = {}): ParsedLogCommit {
  return {
    sha,
    message: `msg ${sha.slice(0, 1)}`,
    author: "Ada",
    date: "2024-01-01T00:00:00+00:00",
    diff: `diff ${sha.slice(0, 1)}`,
    diffTruncated: false,
    foundBy: [],
    committerTime: 100,
    ...overrides,
  };
}

describe("mergeHistory", () => {
  it("unions by SHA and tags each commit with its reads", () => {
    const merged = mergeHistory({
      blame: [commit(A, { diff: "", committerTime: 100 })],
      symbolLog: [commit(A, { committerTime: 100 }), commit(B, { committerTime: 200 })],
      fileLog: [commit(C, { committerTime: 300 })],
    });
    expect(merged.map((c) => c.sha)).toEqual([C, B, A]);
    expect(merged.map((c) => c.foundBy)).toEqual([
      ["file-log"],
      ["symbol-log"],
      ["blame", "symbol-log"],
    ]);
  });

  it("keeps the file-log diff when both logs return a commit", () => {
    const merged = mergeHistory({
      blame: [],
      symbolLog: [commit(A, { diff: "symbol diff", committerTime: 100 })],
      fileLog: [commit(A, { diff: "file diff", committerTime: 100 })],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.diff).toBe("file diff");
    expect(merged[0]?.foundBy).toEqual(["file-log", "symbol-log"]);
  });

  it("keeps an empty diff for blame-only commits", () => {
    const merged = mergeHistory({
      blame: [commit(A, { diff: "", committerTime: 100 })],
      symbolLog: [],
      fileLog: [],
    });
    expect(merged[0]?.diff).toBe("");
    expect(merged[0]?.diffTruncated).toBe(false);
    expect(merged[0]?.foundBy).toEqual(["blame"]);
  });

  it("orders by committer time, then SHA", () => {
    const merged = mergeHistory({
      blame: [],
      symbolLog: [],
      fileLog: [
        commit(B, { committerTime: 100 }),
        commit(A, { committerTime: 100 }),
        commit(C, { committerTime: 50 }),
      ],
    });
    expect(merged.map((c) => c.sha)).toEqual([A, B, C]);
  });
});
