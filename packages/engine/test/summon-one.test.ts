import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfirmedFix } from "../src/llm/confirm-loop.js";
import type { DepsPlan } from "../src/summon/deps-plan.js";
import { summonOne } from "../src/summon/summon-one.js";
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

const opts = {
  testCommand: "node check.mjs",
  timeoutMs: 30_000,
  installTimeoutMs: 20_000,
  excerptChars: 1000,
  extraTestPatterns: [] as string[],
  extraNonCodePatterns: [] as string[],
  rerunOnFail: 0,
};
const none: DepsPlan = { method: "none", workspace: false };
const link: DepsPlan = { method: "link", workspace: false };

const lines = (bug: string) =>
  Array.from({ length: 12 }, (_, i) => (i === 5 ? bug : `const l${i} = ${i};`)).join("\n") + "\n";

// check.mjs fails while src/a.js still contains the bug marker.
const strictCheck = `import fs from "node:fs";
if (fs.readFileSync("src/a.js", "utf8").includes("BUG")) { console.log("bug present"); process.exit(1); }
`;
const looseCheck = `console.log("all good");\n`;

function fixOf(r: TestRepo, i: number): ConfirmedFix {
  return {
    sha: r.shas[i]!,
    parent: r.shas[i - 1] ?? "",
    message: `fix ${i}`,
    matchedRules: ["keyword"],
    llmReason: "looks like a fix",
  };
}

function bugRepo(check: string): TestRepo {
  return repo([
    { message: "init", files: { "check.mjs": check, "src/a.js": lines("const x = 'BUG';") } },
    { message: "fix bug", files: { "src/a.js": lines("const x = 'ok';") } },
  ]);
}

function worktreeCount(dir: string): number {
  return git(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
}

describe("summonOne", () => {
  it("labels escaped when tests still pass with the bug back", async () => {
    const r = bugRepo(looseCheck);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, opts);
    expect(e).toMatchObject({
      label: "escaped",
      sha: r.shas[1],
      filesReverted: ["src/a.js"],
      runs: 1,
    });
    expect(e.lostReason).toBeUndefined();
    expect(e.testOutputExcerpt).toContain("all good");
    expect(worktreeCount(r.dir)).toBe(1);
    expect(git(r.dir, "status", "--porcelain").trim()).toBe("");
  });

  it("labels buried when tests catch the bug", async () => {
    const r = bugRepo(strictCheck);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, opts);
    expect(e.label).toBe("buried");
    expect(e.testOutputExcerpt).toContain("bug present");
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("never reverts test or non-code files", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "test/a.test.js": "1\n", "README.md": "1\n" } },
      { message: "fix", files: { "src/a.js": "2\n", "test/a.test.js": "2\n", "README.md": "2\n" } },
    ]);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, opts);
    expect(e.label).toBe("escaped");
    expect(e.filesReverted).toEqual(["src/a.js"]);
  });

  it("lost: no source files to revert, without a worktree", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "test/a.test.js": "1\n", "README.md": "1\n" } },
      { message: "fix", files: { "test/a.test.js": "2\n", "README.md": "2\n" } },
    ]);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, opts);
    expect(e).toMatchObject({ label: "lost", lostReason: "no source files to revert", filesReverted: [] });
  });

  it("summoned: version-only package.json bump is reverted with the fix when linking", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "package.json": '{"version":"1.0.0"}\n' } },
      { message: "fix", files: { "src/a.js": "2\n", "package.json": '{"version":"1.0.1"}\n' } },
    ]);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), link, opts);
    expect(e.label).toBe("escaped");
    expect(e.filesReverted).toContain("package.json");
  });

  it("lost: invalid-JSON package.json counts as a dependency change", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "package.json": "{}\n" } },
      { message: "fix", files: { "src/a.js": "2\n", "package.json": "{ not json\n" } },
    ]);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), link, opts);
    expect(e).toMatchObject({ label: "lost", lostReason: "fix changes dependencies" });
  });

  it("lost: lockfile change when linking", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "package-lock.json": "{}\n" } },
      { message: "fix", files: { "src/a.js": "2\n", "package-lock.json": '{"x":1}\n' } },
    ]);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), link, opts);
    expect(e).toMatchObject({ label: "lost", lostReason: "fix changes dependencies" });
  });

  it("summoned with an install plan even when dependencies change", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "package.json": "{}\n" } },
      { message: "fix", files: { "src/a.js": "2\n", "package.json": '{"dependencies":{"a":"1"}}\n' } },
    ]);
    const install: DepsPlan = { method: "install", workspace: false };
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), install, {
      ...opts,
      installCommand: "node -e 0",
    });
    expect(e.label).toBe("escaped");
  });

  it("installs dependencies from the reversed manifest", async () => {
    const r = repo([
      {
        message: "init",
        files: {
          "check.mjs": looseCheck,
          "package.json": '{"dependencies":{"a":"1"}}\n',
        },
      },
      {
        message: "fix dependency",
        files: {
          "package.json": '{"dependencies":{"a":"2"}}\n',
        },
      },
    ]);
    const install: DepsPlan = { method: "install", workspace: false };
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), install, {
      ...opts,
      installCommand: `node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); if(p.dependencies.a!== '1') process.exit(7)"`,
    });
    expect(e.label).toBe("escaped");
  });

  it("lost: fix changes dependencies, only when linking", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": "1\n", "package.json": "{}\n" } },
      { message: "fix", files: { "src/a.js": "2\n", "package.json": '{"dependencies":{"a":"1"}}\n' } },
    ]);
    const linked = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), link, opts);
    expect(linked).toMatchObject({ label: "lost", lostReason: "fix changes dependencies" });
    expect(worktreeCount(r.dir)).toBe(1);

    const unlinked = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, opts);
    expect(unlinked.label).toBe("escaped");
  });

  it("links node_modules and leaves the repo's copy intact", async () => {
    const r = bugRepo(looseCheck);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), link, opts);
    expect(e.label).toBe("escaped");
    expect(fs.existsSync(path.join(r.dir, "node_modules", "marker.txt"))).toBe(true);
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("lost: parent commit not available for a root commit", async () => {
    const r = bugRepo(looseCheck);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 0), none, opts);
    expect(e).toMatchObject({ label: "lost", lostReason: "parent commit not available" });
  });

  it("lost: dependency setup failed", async () => {
    const r = bugRepo(looseCheck);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), { method: "install", workspace: false }, {
      ...opts,
      installCommand: `node -e "console.log('no install'); process.exit(1)"`,
    });
    expect(e).toMatchObject({ label: "lost", lostReason: "dependency setup failed" });
    expect(e.testOutputExcerpt).toContain("no install");
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("lost: revert did not apply when a later commit rewrote the fixed lines", async () => {
    const r = repo([
      { message: "init", files: { "check.mjs": looseCheck, "src/a.js": lines("const x = 'BUG';") } },
      { message: "fix bug", files: { "src/a.js": lines("const x = 'ok';") } },
      { message: "rewrite", files: { "src/a.js": lines("const x = 'something else';") } },
    ]);
    const e = await summonOne(r.dir, r.shas[2]!, fixOf(r, 1), none, opts);
    expect(e).toMatchObject({ label: "lost", lostReason: "revert did not apply", filesReverted: ["src/a.js"] });
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("lost: timeout", async () => {
    const r = bugRepo(`setInterval(() => {}, 1000);\n`);
    const e = await summonOne(r.dir, r.shas[1]!, fixOf(r, 1), none, { ...opts, timeoutMs: 1500 });
    expect(e).toMatchObject({ label: "lost", lostReason: "timeout" });
    expect(worktreeCount(r.dir)).toBe(1);
  });

  it("lost: internal error when the worktree cannot be created", async () => {
    const r = bugRepo(looseCheck);
    const e = await summonOne(r.dir, "0".repeat(40), fixOf(r, 1), none, opts);
    expect(e.label).toBe("lost");
    expect(e.lostReason).toMatch(/^internal error: /);
    expect(worktreeCount(r.dir)).toBe(1);
  });
});
