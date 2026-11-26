import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ failLock: false, noRemoveLink: false }));

vi.mock("../src/git/exec.js", async (orig) => {
  const mod = await orig<typeof import("../src/git/exec.js")>();
  return {
    ...mod,
    runGit: (cwd: string, args: string[], opts?: { allowFail?: boolean }) => {
      if (hooks.failLock && args[0] === "worktree" && args[1] === "lock") {
        return Promise.reject(new Error("forced lock failure"));
      }
      return mod.runGit(cwd, args, opts);
    },
  };
});

vi.mock("../src/summon/deps.js", async (orig) => {
  const mod = await orig<typeof import("../src/summon/deps.js")>();
  return {
    ...mod,
    removeLink: (p: string) => (hooks.noRemoveLink ? Promise.resolve() : mod.removeLink(p)),
  };
});

import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import { removeLink } from "../src/summon/deps.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

const summonDirs = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith("hades-summon-"));
const list = (repo: TestRepo) => git(repo.dir, "worktree", "list", "--porcelain");

describe("worktree", () => {
  let repo: TestRepo;
  beforeEach(() => {
    hooks.failLock = false;
    hooks.noRemoveLink = false;
    repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
  });
  afterEach(() => repo.cleanup());

  it("locks with a reason containing the pid", async () => {
    const dir = await createWorktree(repo.dir, repo.shas[0]!);
    try {
      expect(list(repo)).toContain(`locked hades pid=${process.pid}`);
      expect(existsSync(path.join(dir, "a.txt"))).toBe(true);
    } finally {
      await removeWorktree(repo.dir, dir);
    }
  });

  it("removal leaves nothing in the worktree list", async () => {
    const dir = await createWorktree(repo.dir, repo.shas[0]!);
    const r = await removeWorktree(repo.dir, dir);
    expect(r.cleanupWarning).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(list(repo)).not.toContain("hades-summon-");
  });

  it("a failed lock leaves no worktree or folder", async () => {
    const before = new Set(summonDirs());
    hooks.failLock = true;
    await expect(createWorktree(repo.dir, repo.shas[0]!)).rejects.toThrow("forced lock failure");
    expect(summonDirs().filter((n) => !before.has(n))).toEqual([]);
    expect(list(repo)).not.toContain("hades-summon-");
  });

  it("a failed add (bad base) leaves no folder", async () => {
    const before = new Set(summonDirs());
    await expect(createWorktree(repo.dir, "no-such-ref")).rejects.toThrow();
    expect(summonDirs().filter((n) => !before.has(n))).toEqual([]);
  });

  it("removes stale metadata for only the target when the folder was deleted beforehand", async () => {
    const dir = await createWorktree(repo.dir, repo.shas[0]!);
    const unrelated = mkdtempSync(path.join(os.tmpdir(), "hades-unrelated-wt-"));
    rmSync(dir, { recursive: true, force: true });
    try {
      git(repo.dir, "worktree", "add", "--detach", unrelated, repo.shas[0]!);
      expect(list(repo)).toContain("hades-summon-");
      await removeWorktree(repo.dir, dir);
      expect(list(repo)).not.toContain("hades-summon-");
      expect(list(repo)).toContain(unrelated.replace(/\\/g, "/"));
    } finally {
      git(repo.dir, "worktree", "remove", "--force", unrelated);
    }
  });

  it("removes the link without touching its target", async () => {
    const dir = await createWorktree(repo.dir, repo.shas[0]!);
    const link = path.join(dir, "node_modules");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(repo.dir, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
    const r = await removeWorktree(repo.dir, dir, link);
    expect(r.cleanupWarning).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(repo.dir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("a stuck link blocks the recursive delete and sets cleanupWarning", async () => {
    const dir = await createWorktree(repo.dir, repo.shas[0]!);
    // Stand-in for a link that cannot be removed: a path that persists after removeLink.
    const outside = mkdtempSync(path.join(os.tmpdir(), "hades-stuck-"));
    const stuck = path.join(outside, "link");
    mkdirSync(stuck);
    writeFileSync(path.join(stuck, "keep.txt"), "keep");
    hooks.noRemoveLink = true;
    try {
      const r = await removeWorktree(repo.dir, dir, stuck);
      expect(r.cleanupWarning).toBeTruthy();
      expect(existsSync(path.join(stuck, "keep.txt"))).toBe(true);
    } finally {
      hooks.noRemoveLink = false;
      rmSync(outside, { recursive: true, force: true });
      await removeWorktree(repo.dir, dir);
    }
  });

  it("removeLink ignores a missing path and refuses a real directory", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "hades-link-"));
    try {
      await removeLink(path.join(tmp, "nope"));
      await expect(removeLink(tmp)).rejects.toThrow();
      expect(existsSync(tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
