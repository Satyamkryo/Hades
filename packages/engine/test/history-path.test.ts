import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyPath, isInsideRepo } from "../scripts/history-path.js";

const when = new Date("2024-01-02T03:04:05.678Z");

describe("historyPath containment", () => {
  it("builds a path outside the repo", () => {
    const home = path.resolve("/home/u");
    const p = historyPath("/work/proj", "abcdef123", when, home);
    expect(p).toBe(
      path.join(home, ".hades", "history", "proj-abcdef1-2024-01-02T03-04-05-678Z.json"),
    );
  });

  it("allows a repo nested under home (outside destination)", () => {
    const home = path.resolve("/home/u");
    const repo = path.join(home, "repo");
    expect(() => historyPath(repo, "abcdef123", when, home)).not.toThrow();
  });

  it("refuses a destination inside the repo (home equals repo)", () => {
    const home = path.resolve("/home/u");
    expect(() => historyPath(home, "abcdef123", when, home)).toThrow(/Refusing/);
  });

  it("refuses a destination inside the repo (home nested in repo)", () => {
    const repo = path.resolve("/work/proj");
    const home = path.join(repo, "sub");
    expect(() => historyPath(repo, "abcdef123", when, home)).toThrow(/Refusing/);
  });

  it("rejects empty paths and relative descendants, allows outside and absolute", () => {
    const repo = path.resolve("/a/repo");
    // Empty relative path (same directory).
    expect(isInsideRepo(repo, repo)).toBe(true);
    // Relative descendant inside the repo.
    expect(isInsideRepo(repo, path.join(repo, "sub", "file.json"))).toBe(true);
    // Outside destination (parent / sibling).
    expect(isInsideRepo(repo, path.resolve("/a/other"))).toBe(false);
    expect(isInsideRepo(repo, path.dirname(repo))).toBe(false);
    // Absolute relative-path result (different Windows drives) is outside.
    const absRel = path.win32.relative("C:\\repo", "D:\\out\\file.json");
    expect(path.win32.isAbsolute(absRel)).toBe(true);
    if (process.platform === "win32") {
      expect(isInsideRepo("C:\\repo", "D:\\out\\file.json")).toBe(false);
    }
  });
});
