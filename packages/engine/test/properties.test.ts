import fc from "fast-check";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeNonCodeMatcher, makeTestFileMatcher } from "../src/classify/files.js";
import { changedFiles, fixPatch } from "../src/history/fix-diff.js";
import { resurrect } from "../src/resurrect.js";
import type { UnderworldReport } from "../src/report/types.js";
import { reverseApply } from "../src/summon/apply.js";
import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import {
  conflictingScenario,
  extraPatternCase,
  mixedFixScenario,
  type ExtraPatternCase,
  type MixedFixScenario,
} from "./helpers/arbitraries.js";
import { answer, createFakeLlm } from "./helpers/fake-llm.js";
import { parsePropertyRuns, parsePropertyTimeoutMs } from "./helpers/property-runs.js";
import { git, makeRepo as makeRepoRaw, type CommitSpec, type TestRepo } from "./helpers/repo.js";
import { snapshot } from "./helpers/snapshot.js";

// Property tests for the summoning safety guarantees (requirements 12.1 to 12.4).
// Offline: fake LLM, and a fake test command (`node check.mjs`) that runs in milliseconds.

// Git-backed properties: 5 runs by default, 20 with HADES_PROPERTY_RUNS=20 (`npm run test:props:full`).
// An invalid value throws here, so the file fails at load time.
const GIT_RUNS = { numRuns: parsePropertyRuns(process.env.HADES_PROPERTY_RUNS) };
const PROPERTY_TIMEOUT = parsePropertyTimeoutMs(process.env.HADES_PROPERTY_TIMEOUT_MS);

// Repos made by this process only, removed in afterAll as a safety net (cleanup also runs
// in each run's finally block).
const createdRepos: string[] = [];
function makeRepo(commits: CommitSpec[]): TestRepo {
  const r = makeRepoRaw(commits);
  createdRepos.push(r.dir);
  return r;
}
afterAll(() => {
  for (const dir of createdRepos) rmSync(dir, { recursive: true, force: true });
});

/** How the fake test command behaves, or no test script at all. */
type Mode = "pass" | "fail" | "guard" | "no-tests";

interface Case {
  scenario: MixedFixScenario;
  mode: Mode;
  extra: { pattern: ExtraPatternCase; as: "test" | "non-code" } | null;
  dirty: boolean;
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  scenario: mixedFixScenario,
  mode: fc.constantFrom<Mode>("pass", "fail", "guard", "no-tests"),
  extra: fc.option(
    fc.record({ pattern: extraPatternCase, as: fc.constantFrom<"test" | "non-code">("test", "non-code") }),
    { nil: null },
  ),
  dirty: fc.boolean(),
});

/**
 * Scenario commits plus the fake test command. `guard` passes only while the first source
 * file has its fixed content, so reverting that fix is `buried`, and a later commit that
 * rewrote the line makes the baseline itself fail.
 */
function commitsFor(c: Case): CommitSpec[] {
  const commits = c.scenario.commits.map((s) => ({ message: s.message, files: { ...s.files } }));
  const first = commits[0]!.files;
  const guardPath = c.scenario.sourcePaths[0]!;
  const guardWant = JSON.stringify(c.scenario.fixedContent[guardPath]);
  first["check.mjs"] =
    c.mode === "fail"
      ? "process.exit(1);\n"
      : c.mode === "guard"
        ? `import fs from "node:fs";\nprocess.exit(fs.readFileSync(${JSON.stringify(guardPath)}, "utf8") === ${guardWant} ? 0 : 1);\n`
        : "process.exit(0);\n";
  if (c.mode === "no-tests") first["package.json"] = '{"name":"x","scripts":{}}\n';
  if (c.extra) {
    // A file the extra pattern matches, changed by the fix, so it must never be reverted.
    commits[0]!.files[c.extra.pattern.matchingPath] = "export const e = 1;\n";
    commits[1]!.files[c.extra.pattern.matchingPath] = "export const e = 2;\n";
  }
  return commits;
}

function optionsFor(c: Case) {
  const extra =
    c.extra === null
      ? {}
      : c.extra.as === "test"
        ? { extraTestPatterns: [c.extra.pattern.pattern] }
        : { extraNonCodePatterns: [c.extra.pattern.pattern] };
  return {
    ...(c.mode === "no-tests" ? {} : { testCommand: "node check.mjs" }),
    timeoutMs: 30_000,
    installTimeoutMs: 20_000,
    ...extra,
  };
}

/** Small generated repos run in diff-review mode, so the fake LLM confirms by message. */
const byMessage = () =>
  createFakeLlm((user) => (user.includes("fix: ") ? answer(true, "it fixes a bug") : answer(false, "not a fix")));

function worktreePaths(dir: string): string[] {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "));
}

/** Summoning leftovers in the OS temp dir (worktrees and patch folders). */
function tempLeftovers(): string[] {
  return readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("hades-summon-") || n.startsWith("hades-patch-"))
    .sort();
}

/** Make the repo state worth protecting: a second branch, and optionally uncommitted work. */
function prepareRealTree(r: TestRepo, c: Case): void {
  git(r.dir, "branch", "side");
  if (c.dirty) {
    appendFileSync(path.join(r.dir, ...c.scenario.sourcePaths[0]!.split("/")), "// uncommitted edit\n");
    writeFileSync(path.join(r.dir, "scratch.txt"), "untracked\n");
  }
}

describe.sequential("summoning properties", () => {

  /** Properties 1, 3, 4 and 5 all need a full resurrect() run, so one run checks all of them. */
  it(
    "1, 3, 4, 5: after any run the real tree is unchanged, reverted files are source files from the Fix diff, every SHA exists, and nothing is left behind",
    async () => {
      const tmpBefore = tempLeftovers();
      await fc.assert(
        fc.asyncProperty(caseArb, async (c) => {
          const extraTest = c.extra?.as === "test" ? [c.extra.pattern.pattern] : [];
          const extraNonCode = c.extra?.as === "non-code" ? [c.extra.pattern.pattern] : [];
          const isTest = makeTestFileMatcher(extraTest);
          const isNonCode = makeNonCodeMatcher(extraNonCode);

          const r = makeRepo(commitsFor(c));
          try {
            prepareRealTree(r, c);
            const before = snapshot(r.dir);
            const report = await resurrect(r.dir, optionsFor(c), { llm: byMessage() });

            // 1. files, index, HEAD, branches, stash and untracked files are unchanged.
            expect(snapshot(r.dir)).toEqual(before);

            // 3. only source files from the Fix diff are reverted.
            for (const e of report.entries) {
              const inDiff = await changedFiles(r.dir, e.sha);
              for (const f of e.filesReverted) {
                expect(isTest(f)).toBe(false);
                expect(isNonCode(f)).toBe(false);
                expect(c.scenario.testPaths).not.toContain(f);
                expect(c.scenario.nonCodePaths).not.toContain(f);
                if (c.extra) expect(f).not.toBe(c.extra.pattern.matchingPath);
                expect(inDiff).toContain(f);
              }
            }

            // 4. every SHA in the report is a commit in the repo.
            const shas = [
              report.baseSha,
              ...report.entries.map((e) => e.sha),
              ...report.unguarded.map((u) => u.sha),
              ...report.rejected.map((n) => n.sha),
              ...report.llmErrors.map((n) => n.sha),
            ];
            for (const sha of shas) {
              expect(sha).toMatch(/^[0-9a-f]{40}$/);
              // Throws (non-zero exit) when the commit does not exist.
              expect(() => git(r.dir, "cat-file", "-e", `${sha}^{commit}`)).not.toThrow();
            }
            expect(report.droppedUnverified).toEqual([]);

            // 5. only the main worktree remains, no temp folders, node_modules untouched.
            expect(worktreePaths(r.dir)).toHaveLength(1);
            expect(tempLeftovers()).toEqual(tmpBefore);
            expect(readFileSync(path.join(r.dir, "node_modules", "marker.txt"), "utf8")).toBe("marker");
          } finally {
            r.cleanup();
          }
        }),
        GIT_RUNS,
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "1, 5: runs forced to end lost or baseline-failed leave the repo and temp dir clean",
    async () => {
      const tmpBefore = tempLeftovers();
      const forced = fc.record({
        kind: fc.constantFrom<"lost" | "baseline-failed">("lost", "baseline-failed"),
        dirty: fc.boolean(),
      }).chain(({ kind, dirty }) =>
        (kind === "lost" ? conflictingScenario : mixedFixScenario).map((scenario) => ({ scenario, kind, dirty })),
      );
      await fc.assert(
        fc.asyncProperty(forced, async ({ scenario, kind, dirty }) => {
          // lost: a later commit rewrote the fixed lines, so reverse-apply conflicts.
          // baseline-failed: the fake test command fails at HEAD.
          const c: Case = { scenario, mode: kind === "lost" ? "pass" : "fail", extra: null, dirty };
          const r = makeRepo(commitsFor(c));
          try {
            prepareRealTree(r, c);
            const before = snapshot(r.dir);
            const report = await resurrect(r.dir, optionsFor(c), { llm: byMessage() });
            if (kind === "lost") {
              expect(report.entries.some((e) => e.label === "lost")).toBe(true);
            } else {
              expect(report.status).toBe("baseline-failed");
            }
            expect(snapshot(r.dir)).toEqual(before);
            expect(worktreePaths(r.dir)).toHaveLength(1);
            expect(tempLeftovers()).toEqual(tmpBefore);
            expect(readFileSync(path.join(r.dir, "node_modules", "marker.txt"), "utf8")).toBe("marker");
          } finally {
            r.cleanup();
          }
        }),
        GIT_RUNS,
      );
    },
    PROPERTY_TIMEOUT,
  );

  /**
   * The generators are random, so "more than one outcome" and "files really get reverted"
   * cannot be asserted inside a property that runs only a few times. These fixed inputs
   * check that the scenario shapes the properties rely on reach each outcome.
   */
  it("fixed inputs reach ok, no-tests, baseline-failed and lost, and revert real files", async () => {
    const lines = (v: number) => Array.from({ length: 6 }, (_, i) => `export const v${i} = ${i === 3 ? v : i};`).join("\n") + "\n";
    const fixed = (later: boolean): CommitSpec[] => [
      { message: "initial commit", files: { "src/a.js": lines(0), "check.mjs": "process.exit(0);\n" } },
      { message: "fix: crash bug", files: { "src/a.js": lines(1) } },
      ...(later ? [{ message: "refactor: later change", files: { "src/a.js": lines(2) } }] : []),
    ];
    const run = async (commits: CommitSpec[], extra: Record<string, unknown>, files?: Record<string, string>) => {
      const r = makeRepo(files ? [{ ...commits[0]!, files: { ...commits[0]!.files, ...files } }, ...commits.slice(1)] : commits);
      try {
        return await resurrect(r.dir, { timeoutMs: 30_000, installTimeoutMs: 20_000, ...extra }, { llm: byMessage() });
      } finally {
        r.cleanup();
      }
    };
    const testCommand = { testCommand: "node check.mjs" };

    const ok = await run(fixed(false), testCommand);
    expect(ok.status).toBe("ok");
    expect(ok.entries.flatMap((e) => e.filesReverted)).toContain("src/a.js");

    const noTests = await run(fixed(false), {}, { "package.json": '{"name":"x","scripts":{}}\n' });
    expect(noTests.status).toBe("no-tests");

    const baselineFailed = await run(fixed(false), testCommand, { "check.mjs": "process.exit(1);\n" });
    expect(baselineFailed.status).toBe("baseline-failed");

    const lost = await run(fixed(true), testCommand);
    expect(lost.entries.some((e) => e.label === "lost")).toBe(true);
  });

  it(
    "2. reverse-apply then re-apply restores the exact bytes",
    async () => {
      const noConflict = mixedFixScenario.filter((s) => s.later !== "conflicting");
      await fc.assert(
        fc.asyncProperty(noConflict, async (s) => {
          const r = makeRepo(s.commits);
          const patchDir = mkdtempSync(path.join(os.tmpdir(), "hades-proptest-"));
          let wt: string | undefined;
          try {
            const fixSha = r.shas[s.fixIndex]!;
            const head = r.shas[r.shas.length - 1]!;
            const patch = await fixPatch(r.dir, fixSha, s.sourcePaths);
            wt = await createWorktree(r.dir, head);
            const read = (p: string): Buffer => readFileSync(path.join(wt!, ...p.split("/")));

            const reverted = await reverseApply(wt, patch);
            expect(reverted.ok).toBe(true);
            for (const p of s.sourcePaths) {
              expect(read(p).equals(Buffer.from(s.baseContent[p]!, "utf8"))).toBe(true);
            }

            // Re-apply the same patch forward. The patch is parent -> fix, so a plain
            // `git apply` (no -R) puts the fix back.
            const patchFile = path.join(patchDir, "fix.patch");
            writeFileSync(patchFile, patch);
            execFileSync("git", ["apply", "--whitespace=nowarn", patchFile], { cwd: wt });
            for (const p of s.sourcePaths) {
              expect(read(p).equals(Buffer.from(s.fixedContent[p]!, "utf8"))).toBe(true);
              // Same bytes git has for the fix commit.
              const inGit = execFileSync("git", ["show", `${fixSha}:${p}`], { cwd: r.dir });
              expect(read(p).equals(inGit)).toBe(true);
            }
          } finally {
            if (wt !== undefined) await removeWorktree(r.dir, wt);
            rmSync(patchDir, { recursive: true, force: true });
            r.cleanup();
          }
        }),
        GIT_RUNS,
      );
    },
    PROPERTY_TIMEOUT,
  );

});
