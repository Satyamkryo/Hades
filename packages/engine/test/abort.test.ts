import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { throwIfAborted } from "../src/abort.js";
import { HadesAbortError } from "../src/errors.js";
import { runGit } from "../src/git/exec.js";
import { runCommand } from "../src/summon/process.js";
import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import { summonOne } from "../src/summon/summon-one.js";
import type { ConfirmedFix } from "../src/llm/confirm-loop.js";
import type { DepsPlan } from "../src/summon/deps-plan.js";
import { git, makeRepo, type CommitSpec, type TestRepo } from "./helpers/repo.js";

const repos: TestRepo[] = [];
function repo(commits: CommitSpec[]): TestRepo {
  const r = makeRepo(commits);
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

function worktreeCount(dir: string): number {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

function tempLeftovers(): string[] {
  return readdirSync(os.tmpdir()).filter((n) => n.startsWith("hades-summon-"));
}

const lines = (bug: string) =>
  Array.from({ length: 12 }, (_, i) => (i === 5 ? bug : `const l${i} = ${i};`)).join("\n") + "\n";

function fixOf(r: TestRepo, i: number): ConfirmedFix {
  return {
    sha: r.shas[i]!,
    parent: r.shas[i - 1] ?? "",
    message: `fix ${i}`,
    matchedRules: ["keyword"],
    llmReason: "looks like a fix",
  };
}

describe("abort support", () => {
  it("runCommand kills the tree and rejects with HadesAbortError", async () => {
    const r = repo([{ message: "init", files: { "a.txt": "hi\n" } }]);
    const controller = new AbortController();
    const pending = runCommand(`node -e "setInterval(()=>{},1000)"`, r.dir, {
      timeoutMs: 30_000,
      excerptChars: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    await expect(pending).rejects.toBeInstanceOf(HadesAbortError);
  });

  it("runGit rejects with HadesAbortError when aborted", async () => {
    const r = repo([{ message: "init", files: { "a.txt": "hi\n" } }]);
    const controller = new AbortController();
    controller.abort();
    await expect(runGit(r.dir, ["rev-parse", "HEAD"], { signal: controller.signal })).rejects.toBeInstanceOf(
      HadesAbortError,
    );
  });

  it("throwIfAborted throws HadesAbortError, not AbortError", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrowError(HadesAbortError);
    expect(() => throwIfAborted(controller.signal)).toThrowError(
      expect.objectContaining({ name: "HadesAbortError" }),
    );
    // No signal: no throw.
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("abort during a test run removes the worktree and rejects", async () => {
    const beforeTmp = tempLeftovers();
    const r = repo([
      { message: "init", files: { "check.mjs": `setInterval(()=>{},1000);\n`, "src/a.js": lines("BUG") } },
      { message: "fix bug", files: { "src/a.js": lines("ok") } },
    ]);
    const none: DepsPlan = { method: "none", workspace: false };
    const controller = new AbortController();
    const pending = summonOne(
      r.dir,
      r.shas[1]!,
      fixOf(r, 1),
      none,
      {
        testCommand: "node check.mjs",
        timeoutMs: 30_000,
        installTimeoutMs: 20_000,
        excerptChars: 1000,
        extraTestPatterns: [],
        extraNonCodePatterns: [],
        rerunOnFail: 0,
      },
      controller.signal,
    );
    // Let the worktree be created and the test start, then abort.
    const deadline = Date.now() + 10_000;
    while (worktreeCount(r.dir) < 2 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(worktreeCount(r.dir)).toBe(2);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HadesAbortError);
    expect(worktreeCount(r.dir)).toBe(1);
    expect(tempLeftovers()).toEqual(beforeTmp);
  });

  it("abort during install removes the worktree and rejects", async () => {
    const beforeTmp = tempLeftovers();
    const r = repo([
      { message: "init", files: { "check.mjs": `console.log("ok");\n`, "src/a.js": lines("BUG") } },
      { message: "fix bug", files: { "src/a.js": lines("ok") } },
    ]);
    const install: DepsPlan = { method: "install", workspace: false };
    const controller = new AbortController();
    const pending = summonOne(
      r.dir,
      r.shas[1]!,
      fixOf(r, 1),
      install,
      {
        testCommand: "node check.mjs",
        timeoutMs: 30_000,
        installTimeoutMs: 30_000,
        excerptChars: 1000,
        extraTestPatterns: [],
        extraNonCodePatterns: [],
        rerunOnFail: 0,
        installCommand: `node -e "setInterval(()=>{},1000)"`,
      },
      controller.signal,
    );
    const deadline = Date.now() + 10_000;
    while (worktreeCount(r.dir) < 2 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(worktreeCount(r.dir)).toBe(2);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HadesAbortError);
    expect(worktreeCount(r.dir)).toBe(1);
    expect(tempLeftovers()).toEqual(beforeTmp);
  });

  it("abort right after worktree creation still removes the worktree", async () => {
    // createWorktree never takes the signal. Callers call throwIfAborted() right after it,
    // inside the try whose finally removes the worktree.
    const beforeTmp = tempLeftovers();
    const r = repo([{ message: "init", files: { "a.txt": "hi\n" } }]);
    const controller = new AbortController();
    const wt = await createWorktree(r.dir, r.shas[0]!);
    expect(worktreeCount(r.dir)).toBe(2);
    controller.abort();
    try {
      try {
        throwIfAborted(controller.signal);
        expect.unreachable("should have thrown");
      } finally {
        await removeWorktree(r.dir, wt);
      }
    } catch (e) {
      expect(e).toBeInstanceOf(HadesAbortError);
    }
    expect(worktreeCount(r.dir)).toBe(1);
    expect(tempLeftovers()).toEqual(beforeTmp);
    // Also: an already-aborted summonOne that aborts between creation and setup cleans up.
    const r2 = repo([
      { message: "init", files: { "check.mjs": `console.log("ok");\n`, "src/a.js": lines("BUG") } },
      { message: "fix bug", files: { "src/a.js": lines("ok") } },
    ]);
    const none: DepsPlan = { method: "none", workspace: false };
    const c2 = new AbortController();
    // Abort as soon as the worktree appears.
    const pending = summonOne(
      r2.dir,
      r2.shas[1]!,
      fixOf(r2, 1),
      none,
      {
        testCommand: `node -e "setInterval(()=>{},1000)"`,
        timeoutMs: 30_000,
        installTimeoutMs: 20_000,
        excerptChars: 1000,
        extraTestPatterns: [],
        extraNonCodePatterns: [],
        rerunOnFail: 0,
      },
      c2.signal,
    );
    const deadline = Date.now() + 10_000;
    while (worktreeCount(r2.dir) < 2 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 20));
    }
    c2.abort();
    await expect(pending).rejects.toBeInstanceOf(HadesAbortError);
    expect(worktreeCount(r2.dir)).toBe(1);
    expect(tempLeftovers()).toEqual(beforeTmp);
  });

  it("LLM client rejects with HadesAbortError when the run signal aborts", async () => {
    const { createServer } = await import("node:http");
    const { createOpenAiCompatibleClient } = await import("../src/llm/client.js");
    const server = createServer((_req, res) => {
      // Never answer: the abort must win.
      void res;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const client = createOpenAiCompatibleClient(
        { baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", model: "m" },
        { timeoutMs: 30_000, signal: controller.signal },
      );
      const pending = client.complete("sys", "user");
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(HadesAbortError);
    } finally {
      server.close();
    }
    void path;
  });
});
