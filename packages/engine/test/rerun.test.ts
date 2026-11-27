import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfirmedFix } from "../src/llm/confirm-loop.js";
import type { DepsPlan } from "../src/summon/deps-plan.js";
import { summonOne } from "../src/summon/summon-one.js";
import { makeRepo, type CommitSpec, type TestRepo } from "./helpers/repo.js";

const repos: TestRepo[] = [];
const counters: string[] = [];
function repo(commits: CommitSpec[]): TestRepo {
  const r = makeRepo(commits);
  repos.push(r);
  return r;
}
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
  for (const c of counters.splice(0)) fs.rmSync(c, { force: true });
});

const none: DepsPlan = { method: "none", workspace: false };

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

function baseOpts(extra: Record<string, unknown> = {}) {
  return {
    testCommand: "node check.mjs",
    timeoutMs: 30_000,
    installTimeoutMs: 20_000,
    excerptChars: 1000,
    extraTestPatterns: [] as string[],
    extraNonCodePatterns: [] as string[],
    rerunOnFail: 0,
    ...extra,
  };
}

/**
 * A check.mjs that fails on the first run and then does `rerun`: `pass` exits 0,
 * `hang` sleeps past any timeout. State is a counter file outside the worktree, so
 * reruns in the worktree see the attempts so far.
 */
function flakyCheck(rerun: "pass" | "hang"): { counter: string; check: string } {
  const counter = path.join(os.tmpdir(), `hades-rerun-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  counters.push(counter);
  const load = `import fs from "node:fs";
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));`;
  const check =
    rerun === "pass"
      ? `${load}
if (n === 0) { console.log("first-failure-marker"); process.exit(1); }
console.log("rerun-passed-marker");
`
      : `${load}
if (n === 0) { console.log("first-failure-marker"); process.exit(1); }
await new Promise((r) => setTimeout(r, 30000));
`;
  return { counter, check };
}

function bugRepo(check: string): TestRepo {
  return repo([
    { message: "init", files: { "check.mjs": check, "src/a.js": lines("const x = 'BUG';") } },
    { message: "fix bug", files: { "src/a.js": lines("const x = 'ok';") } },
  ]);
}

describe("rerunOnFail", () => {
  it("a passing rerun labels the fix lost (flaky tests) with the first run's excerpt", async () => {
    const { check } = flakyCheck("pass");
    const r = bugRepo(check);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, baseOpts({ rerunOnFail: 2 }));
    expect(e.label).toBe("lost");
    expect(e.lostReason).toBe("flaky tests");
    // Stops after the first passing rerun: 1 + 1 rerun, not 1 + 2.
    expect(e.runs).toBe(2);
    expect(e.testOutputExcerpt).toContain("first-failure-marker");
    expect(e.testOutputExcerpt).not.toContain("rerun-passed-marker");
  });

  it("no passing rerun labels the fix buried with runs 1 + reruns", async () => {
    const counter = path.join(os.tmpdir(), `hades-rerun-${process.pid}-${Date.now()}-always.txt`);
    counters.push(counter);
    const check = `import fs from "node:fs";
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
console.log("failure-run-" + n);
process.exit(1);
`;
    const r = bugRepo(check);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, baseOpts({ rerunOnFail: 2 }));
    expect(e.label).toBe("buried");
    expect(e.runs).toBe(3);
    expect(e.testOutputExcerpt).toContain("failure-run-0");
    expect(e.testOutputExcerpt).not.toContain("failure-run-1");
  });

  it("rerunOnFail 0 never reruns: buried with runs 1", async () => {
    const { check } = flakyCheck("pass");
    const r = bugRepo(check);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, baseOpts({ rerunOnFail: 0 }));
    expect(e.label).toBe("buried");
    expect(e.runs).toBe(1);
    expect(e.testOutputExcerpt).toContain("first-failure-marker");
  });

  it("a rerun that times out counts as a failed rerun", async () => {
    const { check } = flakyCheck("hang");
    const r = bugRepo(check);
    const e = await summonOne(
      r.dir,
      r.shas[1]!,
      fixOf(r, 1),
      none,
      baseOpts({ rerunOnFail: 1, timeoutMs: 2000 }),
    );
    expect(e.label).toBe("buried");
    expect(e.lostReason).toBeUndefined();
    expect(e.runs).toBe(2);
    expect(e.testOutputExcerpt).toContain("first-failure-marker");
  });
});
