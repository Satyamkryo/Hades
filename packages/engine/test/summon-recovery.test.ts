import { existsSync, lstatSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecoveryCommands,
  parseLockedWorktrees,
  recoveryLines,
} from "../scripts/summon-recovery.js";
import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

describe("summon-recovery", () => {
  let repo: TestRepo | undefined;
  let wt: string | undefined;
  afterEach(async () => {
    if (repo && wt) {
      await removeWorktree(repo.dir, wt, path.join(wt, "node_modules"));
    }
    repo?.cleanup();
    repo = undefined;
    wt = undefined;
  });

  it("parses only worktrees locked by this pid", () => {
    const out = [
      "worktree /r",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /a",
      "HEAD abc",
      "detached",
      "locked hades pid=42",
      "",
      "worktree /b",
      "HEAD abc",
      "detached",
      "locked hades pid=7",
      "",
      "worktree /c",
      "HEAD abc",
      "detached",
      "locked",
      "",
    ].join("\n");
    expect(parseLockedWorktrees(out, 42)).toEqual(["/a"]);
  });

  it("builds commands per platform, link removal first and only when linked", () => {
    expect(buildRecoveryCommands("/r", "/w", true, "linux")).toEqual([
      "rm -- '/w/node_modules'",
      "git -C '/r' worktree unlock '/w'",
      "git -C '/r' worktree remove --force '/w'",
    ]);
    expect(buildRecoveryCommands("C:\\r", "C:/w", true, "win32")).toEqual([
      'cmd /c rmdir "C:\\w\\node_modules"',
      'git -C "C:\\r" worktree unlock "C:\\w"',
      'git -C "C:\\r" worktree remove --force "C:\\w"',
    ]);
    expect(buildRecoveryCommands("/r", "/w", false, "linux")).toHaveLength(2);
    expect(buildRecoveryCommands("/repo/it's here", "/work/tree's here", true, "linux")).toEqual([
      "rm -- '/work/tree'\"'\"'s here/node_modules'",
      "git -C '/repo/it'\"'\"'s here' worktree unlock '/work/tree'\"'\"'s here'",
      "git -C '/repo/it'\"'\"'s here' worktree remove --force '/work/tree'\"'\"'s here'",
    ]);
  });

  it("prints ordered commands for a real locked worktree and runs none", async () => {
    repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    wt = await createWorktree(repo.dir, repo.shas[0]!);
    const link = path.join(wt, "node_modules");
    symlinkSync(
      path.join(repo.dir, "node_modules"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const lines = await recoveryLines({ repo: repo.dir, pid: process.pid });
    const cmds = lines.filter((l) => l.startsWith("  ")).map((l) => l.trim());
    expect(cmds).toEqual(buildRecoveryCommands(repo.dir, wt, true));

    // Nothing executed: link, worktree and lock are all still there.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(repo.dir, "node_modules", "marker.txt"))).toBe(true);
    expect(git(repo.dir, "worktree", "list", "--porcelain")).toContain(`locked hades pid=${process.pid}`);
  });

  it("omits the link command when node_modules is not a link", async () => {
    repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    wt = await createWorktree(repo.dir, repo.shas[0]!);
    const lines = await recoveryLines({ repo: repo.dir, pid: process.pid });
    expect(lines.filter((l) => l.startsWith("  "))).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/rmdir|rm "/);
  });

  it("includes a tracked worktree even after it has been unlocked", async () => {
    repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    wt = await createWorktree(repo.dir, repo.shas[0]!);
    git(repo.dir, "worktree", "unlock", wt);
    expect((await recoveryLines({ repo: repo.dir, pid: process.pid })).join("\n")).toContain(wt);
  });
});
