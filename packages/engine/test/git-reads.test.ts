import { describe, expect, it } from "vitest";
import {
  escapeSymbol,
  readBlame,
  readFileLog,
  readMissingCommits,
  readSymbolLog,
} from "../src/ask/git-reads.js";
import { makeRepo } from "./helpers/repo.js";

const ADD_V1 = "int add(int a, int b) {\n  return a + b;\n}\n";
const ADD_V2 = "int add(int a, int b) {\n  return a + b + 1;\n}\n";
const MUL_V1 = "int mul(int a, int b) {\n  return a * b;\n}\n";
const MUL_V2 = "int mul(int a, int b) {\n  return a * b * 2;\n}\n";

/** calc.c with two functions; commit 2 changes add, commit 3 changes mul. */
function makeFuncRepo() {
  return makeRepo([
    { message: "add calc", files: { "calc.c": ADD_V1 + MUL_V1 } },
    { message: "tweak add", files: { "calc.c": ADD_V2 + MUL_V1 } },
    { message: "tweak mul", files: { "calc.c": ADD_V2 + MUL_V2 } },
  ]);
}

describe("escapeSymbol", () => {
  it("escapes basic-regex specials so a symbol matches literally", () => {
    // git matches :funcname: as a basic regular expression (probed on
    // git 2.45.1: `|` and `+` are literal, `\\(` fails with "Unmatched (").
    expect(escapeSymbol("price$v1.5")).toBe("price\\$v1\\.5");
    expect(escapeSymbol("a[b]*c^d\\e")).toBe("a\\[b\\]\\*c\\^d\\\\e");
    expect(escapeSymbol("add(int a, int b)+x|y")).toBe("add(int a, int b)+x|y");
  });
});

describe("readFileLog", () => {
  it("follows renames and returns newest first with diffs", async () => {
    const repo = makeRepo([
      { message: "create", files: { "old.c": ADD_V1 } },
      { message: "change", files: { "old.c": ADD_V2 } },
      { message: "rename", files: { "old.c": null, "new/nested.c": ADD_V2 } },
    ]);
    try {
      const read = await readFileLog({
        repo: repo.dir,
        file: "new/nested.c",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.warning).toBeUndefined();
      expect(read.commits.map((c) => c.sha)).toEqual([...repo.shas].reverse());
      const changed = read.commits.find((c) => c.message === "change");
      expect(changed?.diff).toContain("b + 1");
      for (const commit of read.commits) {
        expect(typeof commit.diff).toBe("string");
      }
    } finally {
      repo.cleanup();
    }
  });

  it("respects maxCommits", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readFileLog({
        repo: repo.dir,
        file: "calc.c",
        maxCommits: 1,
        excerptChars: 4000,
      });
      expect(read.commits).toHaveLength(1);
    } finally {
      repo.cleanup();
    }
  });

  it("reads history of a deleted file without a warning", async () => {
    const repo = makeRepo([
      { message: "create", files: { "gone.c": ADD_V1 } },
      { message: "delete", files: { "gone.c": null } },
    ]);
    try {
      const read = await readFileLog({
        repo: repo.dir,
        file: "gone.c",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.warning).toBeUndefined();
      expect(read.commits).toHaveLength(2);
    } finally {
      repo.cleanup();
    }
  });
});

describe("readSymbolLog", () => {
  it("returns only commits touching the function", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readSymbolLog({
        repo: repo.dir,
        file: "calc.c",
        symbol: "add",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.warning).toBeUndefined();
      expect(read.commits.map((c) => c.message)).toEqual(["tweak add", "add calc"]);
    } finally {
      repo.cleanup();
    }
  });

  it("matches a symbol with regex characters literally", async () => {
    const repo = makeRepo([
      {
        message: "weird",
        files: { "weird.c": "float price$v1.5(int n) {\n  return n + 0.5;\n}\n" },
      },
    ]);
    try {
      const read = await readSymbolLog({
        repo: repo.dir,
        file: "weird.c",
        symbol: "price$v1.5(int n)",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.warning).toBeUndefined();
      expect(read.commits.map((c) => c.message)).toEqual(["weird"]);
    } finally {
      repo.cleanup();
    }
  });

  it("warns on no match instead of throwing", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readSymbolLog({
        repo: repo.dir,
        file: "calc.c",
        symbol: "no_such_function_xyz",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.commits).toEqual([]);
      expect(read.warning).toContain("no_such_function_xyz");
    } finally {
      repo.cleanup();
    }
  });

  it("warns when the file is missing at HEAD", async () => {
    const repo = makeRepo([{ message: "create", files: { "gone.c": ADD_V1 } }]);
    try {
      // delete without committing: file missing at HEAD, history exists.
      const read = await readSymbolLog({
        repo: repo.dir,
        file: "never-existed.c",
        symbol: "add",
        maxCommits: 50,
        excerptChars: 4000,
      });
      expect(read.commits).toEqual([]);
      expect(read.warning).toBeDefined();
    } finally {
      repo.cleanup();
    }
  });
});

describe("readBlame", () => {
  it("returns merged ranges over the requested lines", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readBlame(repo.dir, "calc.c", 1, 6);
      expect(read.warning).toBeUndefined();
      // Only the edited lines move to a newer commit; untouched lines stay old.
      expect(read.ranges).toEqual([
        { start: 1, end: 1, sha: repo.shas[0] },
        { start: 2, end: 2, sha: repo.shas[1] },
        { start: 3, end: 4, sha: repo.shas[0] },
        { start: 5, end: 5, sha: repo.shas[2] },
        { start: 6, end: 6, sha: repo.shas[0] },
      ]);
      expect(read.shas).toEqual([repo.shas[0], repo.shas[1], repo.shas[2]]);
    } finally {
      repo.cleanup();
    }
  });

  it("warns when the path is missing at HEAD", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readBlame(repo.dir, "missing.c", 1, 2);
      expect(read.ranges).toEqual([]);
      expect(read.shas).toEqual([]);
      expect(read.warning).toContain("missing.c");
    } finally {
      repo.cleanup();
    }
  });

  it("warns when the range is past the end of the file", async () => {
    const repo = makeFuncRepo();
    try {
      const read = await readBlame(repo.dir, "calc.c", 1000, 2000);
      expect(read.ranges).toEqual([]);
      expect(read.warning).toContain("1000,2000");
    } finally {
      repo.cleanup();
    }
  });
});

describe("readMissingCommits", () => {
  it("reads blame SHAs without diffs", async () => {
    const repo = makeFuncRepo();
    try {
      const blame = await readBlame(repo.dir, "calc.c", 1, 6);
      const commits = await readMissingCommits(repo.dir, blame.shas);
      expect(commits.map((c) => c.sha).sort()).toEqual([...blame.shas].sort());
      for (const commit of commits) {
        expect(commit.diff).toBe("");
        expect(commit.diffTruncated).toBe(false);
      }
      expect(await readMissingCommits(repo.dir, [])).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
