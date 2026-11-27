import { afterEach, describe, expect, it } from "vitest";
import { resurrect } from "../src/resurrect.js";
import { answer, createFakeLlm, type FakeLlm } from "./helpers/fake-llm.js";
import { git, makeRepo, type CommitSpec, type TestRepo } from "./helpers/repo.js";
import { snapshot } from "./helpers/snapshot.js";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
});

function repo(commits: CommitSpec[]): TestRepo {
  const r = makeRepo(commits);
  repos.push(r);
  return r;
}

// check.mjs fails while src/a.js still contains the bug marker. src/b.js is not checked,
// so reverting the fix of b.js is an escaped soul.
const check = `import fs from "node:fs";
if (fs.readFileSync("src/a.js", "utf8").includes("BUG")) { console.log("bug present"); process.exit(1); }
`;

const opts = { testCommand: "node check.mjs", timeoutMs: 30_000, installTimeoutMs: 20_000 };

/** Small generated repos run in diff-review mode, so the fake LLM confirms by message. */
const byMessage = (): FakeLlm =>
  createFakeLlm((user) => (user.includes("fix: ") ? answer(true, "it fixes a bug") : answer(false, "not a fix")));

function history(a: string, extra: Record<string, string> = {}): CommitSpec[] {
  return [
    { message: "init", files: { "check.mjs": check, "src/a.js": `const a = 'BUG';\n${a}`, "src/b.js": "const b = 'BUGB';\n", ...extra } },
    { message: "fix: a", files: { "src/a.js": `const a = 'ok';\n${a}` } },
    { message: "fix: b", files: { "src/b.js": "const b = 'ok';\n" } },
    { message: "feat: unrelated", files: { "src/c.js": "const c = 1;\n" } },
  ];
}

function worktreeCount(dir: string): number {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

describe("resurrect end to end", () => {
  it("does not create candidate worktrees after cancellation during confirmation", async () => {
    const r = repo(history(""));
    const controller = new AbortController();
    const inner = byMessage();
    const llm: FakeLlm = {
      calls: inner.calls,
      async complete(system, user) {
        controller.abort();
        return inner.complete(system, user);
      },
    };
    await expect(resurrect(r.dir, opts, { llm, signal: controller.signal })).rejects.toMatchObject({ name: "HadesAbortError" });
    expect(worktreeCount(r.dir)).toBe(1);
  });
  it("labels escaped and buried, rejects non-fixes, and leaves the repo untouched", async () => {
    const r = repo(history(""));
    const before = snapshot(r.dir);
    const llm = byMessage();

    const report = await resurrect(r.dir, opts, { llm });

    expect(report.status).toBe("ok");
    expect(report.baseSha).toBe(r.shas[3]);
    expect(report.entries.map((e) => [e.message, e.label])).toEqual([
      ["fix: b", "escaped"],
      ["fix: a", "buried"],
    ]);
    expect(report.entries[0]!.filesReverted).toEqual(["src/b.js"]);
    // The root commit is not scanned, so three commits are Candidates.
    expect(report.rejected.map((x) => x.message)).toEqual(["feat: unrelated"]);
    expect(report.totals).toMatchObject({
      commitsScanned: 3,
      candidates: 3,
      rejectedByLlm: 1,
      processed: 2,
      escaped: 1,
      buried: 1,
      lost: 0,
      unguarded: 0,
    });
    for (const e of report.entries) expect(r.shas).toContain(e.sha);
    expect(report.droppedUnverified).toEqual([]);

    expect(snapshot(r.dir)).toEqual(before);
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("stops at limit confirmed fixes", async () => {
    const r = repo(history(""));
    const llm = byMessage();
    const report = await resurrect(r.dir, { ...opts, limit: 1 }, { llm });
    expect(report.entries.map((e) => e.message)).toEqual(["fix: b"]);
    expect(report.totals.unchecked).toBe(report.totals.candidates - llm.calls.length);
  });

  it("stops at maxLlmChecks and counts the rest as unchecked", async () => {
    const r = repo(history(""));
    const llm = byMessage();
    const report = await resurrect(r.dir, { ...opts, maxLlmChecks: 2 }, { llm });
    expect(llm.calls).toHaveLength(2);
    expect(report.totals.unchecked).toBe(1);
    expect(report.entries.map((e) => e.message)).toEqual(["fix: b"]);
  });

  it("labels a fix lost when a later commit rewrote the fixed lines", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": "process.exit(0);\n", "src/a.js": "const x = 'BUG';\n" } },
      { message: "fix: a", files: { "src/a.js": "const x = 'ok';\n" } },
      { message: "rewrite", files: { "src/a.js": "const x = 'other';\n" } },
    ]);
    const report = await resurrect(r.dir, opts, { llm: byMessage() });
    const entry = report.entries.find((e) => e.message === "fix: a")!;
    expect(entry.label).toBe("lost");
    expect(entry.lostReason).toBe("revert did not apply");
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("returns baseline-failed with zero LLM calls when tests fail at HEAD", async () => {
    // HEAD still contains the bug marker, so the baseline run fails.
    const r = repo([
      { message: "init", files: { "check.mjs": check, "src/a.js": "const a = 'BUG';\n" } },
      { message: "fix: other", files: { "src/b.js": "const b = 1;\n" } },
    ]);
    const llm = byMessage();
    const report = await resurrect(r.dir, opts, { llm });

    expect(report.status).toBe("baseline-failed");
    expect(llm.calls).toHaveLength(0);
    expect(report.baseline?.passed).toBe(false);
    expect(report.baseline?.reason).toContain("tests failed");
    expect(report.entries).toEqual([]);
    expect(worktreeCount(r.dir)).toBe(1);
  });
});

describe("resurrect in a repo with no test script", () => {
  const noTestHistory = (): CommitSpec[] =>
    history("", { "package.json": '{"name":"x","scripts":{}}\n' });

  it("reports no-tests, creates no worktree, and lists Confirmed fixes as unguarded", async () => {
    const r = repo(noTestHistory());
    const before = snapshot(r.dir);
    const seen: number[] = [];
    const inner = byMessage();
    const llm: FakeLlm = {
      calls: inner.calls,
      async complete(system, user) {
        seen.push(worktreeCount(r.dir));
        return inner.complete(system, user);
      },
    };

    // No testCommand: the test-suite check applies.
    const report = await resurrect(r.dir, {}, { llm });

    expect(report.status).toBe("no-tests");
    expect(report.entries).toEqual([]);
    expect(report.baseline).toBeUndefined();
    expect(report.deps).toEqual({ method: "none", workspace: false });
    expect(report.unguarded.map((u) => u.message)).toEqual(["fix: b", "fix: a"]);
    for (const u of report.unguarded) {
      expect(r.shas).toContain(u.sha);
      expect(u.files.length).toBeGreaterThan(0);
    }
    expect(report.unguarded[0]!.files).toEqual(["src/b.js"]);
    expect(report.totals).toMatchObject({ unguarded: 2, processed: 0, escaped: 0, buried: 0, lost: 0 });
    expect(report.droppedUnverified).toEqual([]);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 1)).toBe(true);
    expect(worktreeCount(r.dir)).toBe(1);
    expect(snapshot(r.dir)).toEqual(before);
  });

  it("runs normally with an explicit testCommand", async () => {
    const r = repo(noTestHistory());
    const report = await resurrect(r.dir, opts, { llm: byMessage() });

    expect(report.status).toBe("ok");
    expect(report.unguarded).toEqual([]);
    expect(report.baseline?.passed).toBe(true);
    expect(report.entries.map((e) => [e.message, e.label])).toEqual([
      ["fix: b", "escaped"],
      ["fix: a", "buried"],
    ]);
    expect(worktreeCount(r.dir)).toBe(1);
  });
});
