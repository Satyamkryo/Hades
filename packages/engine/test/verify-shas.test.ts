import { describe, expect, it } from "vitest";
import { gitCallCount } from "../src/git/exec.js";
import { existingCommits } from "../src/git/verify-shas.js";
import { git, makeRepo } from "./helpers/repo.js";

const MISSING = "deadbeef".repeat(5);
const ZERO = "0".repeat(40);

describe("existingCommits", () => {
  it("keeps commits and drops trees, missing objects and invalid input with one git call", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      const commit = repo.shas[0] ?? "";
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      const tree = git(repo.dir, "rev-parse", "HEAD^{tree}").trim();
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(tree).not.toBe(commit);

      const before = gitCallCount();
      const found = await existingCommits(repo.dir, [
        commit,
        tree,
        MISSING,
        "xyz",
        "abc123",
        ZERO,
        commit,
      ]);
      expect(gitCallCount()).toBe(before + 1);
      expect(found).toEqual(new Set([commit]));
    } finally {
      repo.cleanup();
    }
  });

  it("makes no git call when every SHA is invalid", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      const before = gitCallCount();
      const found = await existingCommits(repo.dir, ["xyz", "", ZERO, "123"]);
      expect(found.size).toBe(0);
      expect(gitCallCount()).toBe(before);
    } finally {
      repo.cleanup();
    }
  });
});
