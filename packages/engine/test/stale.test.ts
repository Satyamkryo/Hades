import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanStaleWorktrees, isPidDead, parseWorktreeList } from "../src/summon/stale.js";
import { currentProcessOwnerIdentity, hadesLockReason } from "../src/summon/owner-identity.js";
import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import { resurrect } from "../src/resurrect.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";
import { answer, createFakeLlm } from "./helpers/fake-llm.js";

const repos: TestRepo[] = [];
function repo(): TestRepo {
  const r = makeRepo([{ message: "init", files: { "a.txt": "a\n" } }]);
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) {
    try {
      // Remove any worktrees this test left behind before deleting the repo.
      for (const line of git(r.dir, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ")) {
          const p = norm(line.slice("worktree ".length).trim());
          if (norm(p) !== norm(r.dir) && existsSync(p)) {
            try {
              git(r.dir, "worktree", "remove", "--force", p);
            } catch {
              // Best effort per worktree.
            }
          }
        }
      }
    } catch {
      // Best effort; the repo delete below still runs.
    }
    r.cleanup();
  }
});

/** A pid that is guaranteed dead: spawn node, wait for exit, return its pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  expect(isPidDead(pid)).toBe(true);
  return pid;
}

const norm = (p: string): string => path.normalize(p);

async function ownerReason(pid: number): Promise<string> {
  const identity = await currentProcessOwnerIdentity();
  expect(identity).toBeDefined();
  return hadesLockReason(pid, identity);
}

function worktreePaths(dir: string): string[] {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => norm(l.slice("worktree ".length).trim()));
}

function lockReason(dir: string, wt: string): string | undefined {
  const out = git(dir, "worktree", "list", "--porcelain");
  const target = norm(wt);
  const blocks = out.split(/\r?\n\r?\n/);
  for (const b of blocks) {
    if (norm(b).includes(target)) {
      for (const line of b.split("\n")) {
        if (line.startsWith("locked")) return line;
      }
      return "";
    }
  }
  return undefined;
}

describe("stale cleanup", () => {
  it("parses porcelain records with locked reasons", () => {
    const porcelain = [
      "worktree /main",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /tmp/hades-summon-x",
      "HEAD abc",
      "detached",
      "locked hades pid=1234",
      "",
      "worktree /tmp/other",
      "HEAD abc",
      "locked",
      "",
    ].join("\n");
    const records = parseWorktreeList(porcelain);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ path: "/main" });
    expect(records[1]).toEqual({ path: "/tmp/hades-summon-x", locked: "hades pid=1234" });
    expect(records[2]).toEqual({ path: "/tmp/other", locked: "" });
  });

  it("removes only a dead-pid locked hades-summon-* worktree inside tmpdir", async () => {
    const r = repo();
    const dead = await deadPid();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    // Re-lock with the dead pid.
    git(r.dir, "worktree", "unlock", wt);
    git(r.dir, "worktree", "lock", "--reason", await ownerReason(dead), wt);
    expect(worktreePaths(r.dir)).toContain(norm(wt));

    const cleaned = await cleanStaleWorktrees(r.dir);
    expect(cleaned).toBe(1);
    expect(worktreePaths(r.dir)).not.toContain(norm(wt));
    expect(existsSync(wt)).toBe(false);
  });

  it("leaves a live-pid locked hades-summon-* worktree", async () => {
    const r = repo();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    try {
      expect(lockReason(r.dir, wt) ?? "").toContain(`hades pid=${process.pid}`);
      const cleaned = await cleanStaleWorktrees(r.dir);
      expect(cleaned).toBe(0);
      expect(worktreePaths(r.dir)).toContain(norm(wt));
      expect(existsSync(wt)).toBe(true);
    } finally {
      await removeWorktree(r.dir, wt);
    }
  });

  it("does not infer a dead owner across hosts or PID namespaces", async () => {
    const r = repo();
    const dead = await deadPid();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    const identity = await currentProcessOwnerIdentity();
    expect(identity).toBeDefined();
    try {
      const otherOwners = [
        { host: `${identity!.host}-other`, pidNamespace: identity!.pidNamespace },
        { host: identity!.host, pidNamespace: `${identity!.pidNamespace}-other` },
      ];
      for (const owner of otherOwners) {
        git(r.dir, "worktree", "unlock", wt);
        git(r.dir, "worktree", "lock", "--reason", hadesLockReason(dead, owner), wt);
        let pidChecks = 0;
        expect(
          await cleanStaleWorktrees(r.dir, {
            kill: () => {
              pidChecks += 1;
              throw Object.assign(new Error("no such process"), { code: "ESRCH" });
            },
          }),
        ).toBe(0);
        expect(pidChecks).toBe(0);
        expect(worktreePaths(r.dir)).toContain(norm(wt));
      }
    } finally {
      await removeWorktree(r.dir, wt);
    }
  });

  it("never removes an unlocked hades-summon-* worktree", async () => {
    const r = repo();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    git(r.dir, "worktree", "unlock", wt);
    try {
      const cleaned = await cleanStaleWorktrees(r.dir);
      expect(cleaned).toBe(0);
      expect(worktreePaths(r.dir)).toContain(norm(wt));
    } finally {
      await removeWorktree(r.dir, wt);
    }
  });

  it("never removes a non-Hades locked worktree", async () => {
    const r = repo();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    git(r.dir, "worktree", "unlock", wt);
    git(r.dir, "worktree", "lock", "--reason", "other tool", wt);
    try {
      const cleaned = await cleanStaleWorktrees(r.dir);
      expect(cleaned).toBe(0);
      expect(worktreePaths(r.dir)).toContain(norm(wt));
    } finally {
      // Unlock first so removeWorktree sees the standard state.
      git(r.dir, "worktree", "unlock", wt);
      await removeWorktree(r.dir, wt);
    }
  });

  it("removes the node_modules link first and keeps the repo target", async () => {
    const fs = await import("node:fs/promises");
    const r = repo();
    const dead = await deadPid();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    git(r.dir, "worktree", "unlock", wt);
    git(r.dir, "worktree", "lock", "--reason", await ownerReason(dead), wt);
    const link = path.join(wt, "node_modules");
    await fs.symlink(
      path.resolve(r.dir, "node_modules"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const cleaned = await cleanStaleWorktrees(r.dir);
    expect(cleaned).toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(path.join(r.dir, "node_modules", "marker.txt"))).toBe(true);
  });

  it("fills totals.staleCleaned on a real run", async () => {
    const r = repo();
    const dead = await deadPid();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    git(r.dir, "worktree", "unlock", wt);
    git(r.dir, "worktree", "lock", "--reason", await ownerReason(dead), wt);
    const llm = createFakeLlm((user) => (user.includes("fix: ") ? answer(true, "x") : answer(false, "y")));
    const report = await resurrect(
      r.dir,
      { testCommand: "node -e \"process.exit(0)\"" },
      { llm },
    );
    expect(report.totals.staleCleaned).toBe(1);
    expect(worktreePaths(r.dir)).toHaveLength(1);
    expect(existsSync(wt)).toBe(false);
  });

  it("os.tmpdir scoping: a dead-pid hades-summon-* worktree outside tmpdir is left alone", async () => {
    const r = repo();
    const dead = await deadPid();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    git(r.dir, "worktree", "unlock", wt);
    git(r.dir, "worktree", "lock", "--reason", await ownerReason(dead), wt);
    try {
      // Pretend the temp dir is elsewhere: the real stale worktree is now "outside".
      const cleaned = await cleanStaleWorktrees(r.dir, { tmpdir: path.join(r.dir, "fake-tmp") });
      expect(cleaned).toBe(0);
      expect(worktreePaths(r.dir)).toContain(norm(wt));
    } finally {
      git(r.dir, "worktree", "unlock", wt);
      await removeWorktree(r.dir, wt);
    }
    void os;
  });
});
