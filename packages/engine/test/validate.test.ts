import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HadesConfigError } from "../src/errors.js";
import { isSupportedGit, parseGitVersion, validateRepo } from "../src/repo/validate.js";
import { git, makeRepo } from "./helpers/repo.js";
import { snapshot } from "./helpers/snapshot.js";

describe("git version", () => {
  it("parses and compares", () => {
    expect(parseGitVersion("git version 2.45.1.windows.1")).toEqual([2, 45]);
    expect(isSupportedGit([2, 30])).toBe(true);
    expect(isSupportedGit([2, 29])).toBe(false);
    expect(isSupportedGit([3, 0])).toBe(true);
  });
});

describe("validateRepo", () => {
  it("returns the base commit for a repo root and does not touch the repo", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      const before = snapshot(repo.dir);
      const v = await validateRepo(repo.dir);
      expect(v.baseSha).toBe(repo.shas[0]);
      expect(snapshot(repo.dir)).toEqual(before);
    } finally {
      repo.cleanup();
    }
  });

  it("uses the requested repo HEAD when GIT_DIR points elsewhere", async () => {
    const first = makeRepo([{ message: "first", files: { "a.txt": "first" } }]);
    const second = makeRepo([{ message: "second", files: { "b.txt": "second" } }]);
    const previous = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = path.join(first.dir, ".git");
      const v = await validateRepo(second.dir);
      expect(v.baseSha).toBe(second.shas[0]);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      first.cleanup();
      second.cleanup();
    }
  });

  it("rejects a subfolder of a repo", async () => {
    const repo = makeRepo([{ message: "init", files: { "src/a.txt": "a" } }]);
    try {
      await expect(validateRepo(path.join(repo.dir, "src"))).rejects.toThrow(/root/);
    } finally {
      repo.cleanup();
    }
  });

  it("rejects a folder that is not a repo", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hades-nonrepo-")));
    try {
      await expect(validateRepo(dir)).rejects.toThrow(HadesConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects relative and missing paths", async () => {
    await expect(validateRepo("relative/path")).rejects.toThrow(/absolute/);
    await expect(validateRepo(path.join(os.tmpdir(), "hades-does-not-exist-xyz"))).rejects.toThrow(
      /does not exist/,
    );
  });

  it("detects an empty repo", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hades-empty-")));
    try {
      git(dir, "init", "-q");
      mkdirSync(path.join(dir, "x"));
      const v = await validateRepo(dir);
      expect(v.baseSha).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
