import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCallCount } from "../src/git/exec.js";
import { scanRepoHistory, unquotePath } from "../src/haunted/scan.js";
import { rankHaunted } from "../src/haunted/rank-haunted.js";
import { makeRepo } from "./helpers/repo.js";

const A_V1 = "export const a = 1;\n";
const A_V2 = "export const a = 2;\n";
const A_V3 = "export const a = 3;\n";
const B_V1 = "export const b = 1;\n";
const KEPT = "export const kept = 1;\n";
const GONE = "export const gone = 1;\n";

const tempHomes: string[] = [];
function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "hades-home-"));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

function makeHauntedRepo() {
  return makeRepo([
    { message: "fix crash in a and b", files: { "src/a.ts": A_V1, "src/b.ts": B_V1, "old.ts": "old" } },
    { message: 'Revert "bad change"', files: { "src/a.ts": A_V2 } },
    {
      message: "refactor stuff",
      files: { "src/a.ts": A_V3, "src/test/a.test.ts": "test", "README.md": "docs" },
    },
    { message: "fix names", files: { "old.ts": null, "src/kept.ts": KEPT } },
    { message: "remove gone file", files: { "src/gone.ts": GONE } },
    { message: "actually delete it", files: { "src/gone.ts": null } },
  ]);
}

describe("rankHaunted", () => {
  it("scores fixes above reverts above churn and breaks ties by path", async () => {
    const repo = makeHauntedRepo();
    try {
      const report = await rankHaunted(repo.dir, {}, { hadesHome: makeHome() });
      expect(report.headSha).toBe(repo.shas[repo.shas.length - 1]);
      expect(report.commitsScanned).toBe(6);
      expect(report.warnings).toEqual([]);
      expect(report.files.map((f) => f.path)).toEqual(["src/a.ts", ".gitignore", "src/b.ts", "src/kept.ts"]);

      const [a, gitignore, b, kept] = report.files as [typeof report.files[number], typeof report.files[number], typeof report.files[number], typeof report.files[number]];
      expect(a).toMatchObject({ fixes: 1, reverts: 1, churn: 3, score: 5.3 });
      expect(a?.fixShas).toEqual([repo.shas[0]]);
      expect(a?.revertShas).toEqual([repo.shas[1]]);
      expect(gitignore).toMatchObject({ fixes: 1, reverts: 0, churn: 1, score: 3.1 });
      expect(b).toMatchObject({ fixes: 1, reverts: 0, churn: 1, score: 3.1 });
      expect(kept).toMatchObject({ fixes: 1, reverts: 0, churn: 1, score: 3.1 });
    } finally {
      repo.cleanup();
    }
  });

  it("excludes deleted, renamed-away, test and non-code paths", async () => {
    const repo = makeHauntedRepo();
    try {
      const report = await rankHaunted(repo.dir, {}, { hadesHome: makeHome() });
      const paths = report.files.map((f) => f.path);
      expect(paths).not.toContain("src/gone.ts");
      expect(paths).not.toContain("old.ts");
      expect(paths).not.toContain("src/test/a.test.ts");
      expect(paths).not.toContain("README.md");
    } finally {
      repo.cleanup();
    }
  });

  it("honours top and extra patterns", async () => {
    const repo = makeHauntedRepo();
    try {
      const top = await rankHaunted(repo.dir, { top: 2 }, { hadesHome: makeHome() });
      expect(top.files.map((f) => f.path)).toEqual(["src/a.ts", ".gitignore"]);

      const extra = await rankHaunted(
        repo.dir,
        { extraTestPatterns: ["src/kept.ts"] },
        { hadesHome: makeHome() },
      );
      expect(extra.files.map((f) => f.path)).toEqual(["src/a.ts", ".gitignore", "src/b.ts"]);

      const nonCode = await rankHaunted(
        repo.dir,
        { extraNonCodePatterns: ["src/b.ts"] },
        { hadesHome: makeHome() },
      );
      expect(nonCode.files.map((f) => f.path)).toEqual(["src/a.ts", ".gitignore", "src/kept.ts"]);
    } finally {
      repo.cleanup();
    }
  });

  it("uses exactly 6 git calls", async () => {
    const repo = makeHauntedRepo();
    try {
      const before = gitCallCount();
      await rankHaunted(repo.dir, {}, { hadesHome: makeHome() });
      expect(gitCallCount() - before).toBe(6);
    } finally {
      repo.cleanup();
    }
  });

  it("reports an empty repo with a warning", async () => {
    const repo = makeRepo([]);
    try {
      const report = await rankHaunted(repo.dir, {}, { hadesHome: makeHome() });
      expect(report.headSha).toBeNull();
      expect(report.files).toEqual([]);
      expect(report.warnings).toEqual(["repo has no commits"]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("scanRepoHistory", () => {
  it("uses the recorded revision and reports renames as a deletion and addition", async () => {
    const repo = makeRepo([
      { message: "initial", files: { "src/old.ts": "export const value = 1;\n" } },
      {
        message: "rename source",
        files: { "src/old.ts": null, "src/new.ts": "export const value = 1;\n" },
      },
    ]);
    try {
      const atRecordedHead = await scanRepoHistory(repo.dir, 20, repo.shas[0]!);
      expect(atRecordedHead.commits).toHaveLength(1);
      expect(atRecordedHead.headPaths).toEqual(new Set([".gitignore", "src/old.ts"]));

      const atCurrentHead = await scanRepoHistory(repo.dir, 20, repo.shas[1]!);
      expect(atCurrentHead.commits[0]?.paths).toEqual(expect.arrayContaining(["src/old.ts", "src/new.ts"]));
      expect(atCurrentHead.headPaths).toContain("src/new.ts");
      expect(atCurrentHead.headPaths).not.toContain("src/old.ts");
    } finally {
      repo.cleanup();
    }
  });
});

describe("unquotePath", () => {
  it("decodes git C-style quoting", () => {
    expect(unquotePath('"a\\"b.c"')).toBe('a"b.c');
    expect(unquotePath('"a\\\\b.c"')).toBe("a\\b.c");
    expect(unquotePath('"a\\nb.c"')).toBe("a\nb.c");
    expect(unquotePath('"\\346\\226\\207.txt"')).toBe("文.txt");
    expect(unquotePath("plain.ts")).toBe("plain.ts");
    expect(unquotePath("")).toBe("");
  });
});
