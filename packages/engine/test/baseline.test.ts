import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineHints, runBaseline } from "../src/summon/baseline.js";
import type { DepsPlan } from "../src/summon/deps-plan.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

const repos: TestRepo[] = [];
function repo(files: Record<string, string>): TestRepo {
  const r = makeRepo([{ message: "init", files }]);
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const node = JSON.stringify(process.execPath);
const opts = (testCommand: string, timeoutMs = 30_000) => ({
  testCommand,
  timeoutMs,
  installTimeoutMs: 20_000,
  excerptChars: 1000,
});
const none: DepsPlan = { method: "none", workspace: false };
const link: DepsPlan = { method: "link", workspace: false };

function worktreeCount(dir: string): number {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

describe("runBaseline", () => {
  it("passes and cleans up", async () => {
    const r = repo({ "a.txt": "x" });
    const res = await runBaseline(r.dir, r.shas[0]!, none, opts(`${node} -e "process.exit(0)"`));
    expect(res.passed).toBe(true);
    expect(res.worktreePath).toBeTruthy();
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("reports failing tests with an excerpt and cleans up", async () => {
    const r = repo({ "a.txt": "x" });
    const res = await runBaseline(
      r.dir,
      r.shas[0]!,
      none,
      opts(`${node} -e "console.log('boom'); process.exit(1)"`),
    );
    expect(res).toMatchObject({ passed: false, reason: "tests failed" });
    expect(res.excerpt).toContain("boom");
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("reports timeout", async () => {
    const r = repo({ "a.txt": "x" });
    const res = await runBaseline(
      r.dir,
      r.shas[0]!,
      none,
      opts(`${node} -e "setTimeout(()=>{},60000)"`, 500),
    );
    expect(res).toMatchObject({ passed: false, reason: "timeout" });
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("links node_modules, cleans up, and keeps the Repo's node_modules", async () => {
    const r = repo({ "a.txt": "x" });
    const res = await runBaseline(
      r.dir,
      r.shas[0]!,
      link,
      opts(`${node} -e "process.exit(require('fs').existsSync('node_modules/marker.txt')?0:1)"`),
    );
    expect(res.passed).toBe(true);
    expect(fs.existsSync(path.join(r.dir, "node_modules", "marker.txt"))).toBe(true);
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("fails with a worktree reason for an unknown base", async () => {
    const r = repo({ "a.txt": "x" });
    const res = await runBaseline(r.dir, "0".repeat(40), none, opts(`${node} -e ""`));
    expect(res).toMatchObject({ passed: false });
    expect(res.passed === false && res.reason).toContain("worktree setup failed");
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("appends hints to a failure reason", async () => {
    const r = repo({ ".gitmodules": "" });
    const res = await runBaseline(r.dir, r.shas[0]!, none, opts(`${node} -e "process.exit(1)"`));
    expect(res.passed === false && res.reason).toMatch(/^tests failed\. .*submodules/);
  });
});

describe("baselineHints", () => {
  it("no hints for a plain repo", async () => {
    const r = repo({ "a.txt": "x" });
    expect(await baselineHints(r.dir)).toEqual([]);
  });

  it("hints at .gitmodules", async () => {
    const r = repo({ ".gitmodules": '[submodule "x"]\n' });
    const h = await baselineHints(r.dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain("submodules");
  });

  it("hints at filter=lfs", async () => {
    const r = repo({ ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" });
    const h = await baselineHints(r.dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain("LFS");
  });

  it("hints at ignored .env files but not tracked or absent ones", async () => {
    const r = repo({ ".gitignore": "node_modules/\n.env*\n" });
    expect(await baselineHints(r.dir)).toEqual([]);
    fs.writeFileSync(path.join(r.dir, ".env.local"), "SECRET=1");
    const h = await baselineHints(r.dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toContain(".env");
  });
});
