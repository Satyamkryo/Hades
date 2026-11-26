// Spike: does `git apply -R --3way` (and the fallback `git apply --3way` with a
// pre-reversed patch) behave as the summoning engine needs?
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const GIT_LOCATION_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

export function spikeGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of GIT_LOCATION_OVERRIDES) delete env[name];
  return env;
}

const env = spikeGitEnvironment();

function git(cwd: string, args: string[], allowFail = false) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`);
const BASE = lines(20);
const join_ = (a: string[]) => a.join("\n") + "\n";

interface Fixture {
  repo: string;
  F: string;
  L: string;
  expected: string; // content of src/a.js after undoing F on top of L
}

const tmpRoots: string[] = [];

/** Build A -> F -> L. `conflict` makes L rewrite the lines F changed. */
function buildRepo(conflict: boolean): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "hades-spike-"));
  tmpRoots.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Spike"]);
  git(repo, ["config", "user.email", "spike@example.com"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  mkdirSync(join(repo, "src"));
  const file = join(repo, "src", "a.js");

  writeFileSync(file, join_(BASE));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "A base"]);

  // F: the fix changes line 10
  const fixed = [...BASE];
  fixed[9] = "line10 FIXED";
  writeFileSync(file, join_(fixed));
  git(repo, ["commit", "-qam", "F fix bug"]);
  const F = git(repo, ["rev-parse", "HEAD"]).out.trim();

  const later = [...fixed];
  let expected: string;
  if (conflict) {
    later[9] = "line10 REWRITTEN LATER";
    expected = "";
  } else {
    // L changes lines inside the patch's 3-line context (8 and 12) but not directly
    // adjacent to the fix: adjacent edits are a true merge conflict in git.
    later[7] = "line8 CHANGED LATER";
    later[11] = "line12 CHANGED LATER";
    const exp = [...later];
    exp[9] = "line10"; // undoing F restores the original line 10
    expected = join_(exp);
  }
  writeFileSync(file, join_(later));
  git(repo, ["commit", "-qam", "L later change"]);
  const L = git(repo, ["rev-parse", "HEAD"]).out.trim();
  return { repo, F, L, expected };
}

type Variant = {
  name: string;
  patchArgs: (F: string) => string[];
  applyArgs: string[];
};

const variants: Variant[] = [
  {
    name: "-R --3way (patch F^ -> F)",
    patchArgs: (F) => ["diff", "--binary", "--full-index", `${F}^`, F],
    applyArgs: ["apply", "-R", "--3way", "--whitespace=nowarn"],
  },
  {
    name: "fallback --3way (patch F -> F^)",
    patchArgs: (F) => ["diff", "--binary", "--full-index", F, `${F}^`],
    applyArgs: ["apply", "--3way", "--whitespace=nowarn"],
  },
];

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("spike Git environment", () => {
  it("removes repository-location overrides without mutating process.env", () => {
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: "/other/repo/.git",
      GIT_WORK_TREE: "/other/repo",
      GIT_INDEX_FILE: "/other/repo/index",
      KEEP_ME: "preserved",
    };
    const before = { ...process.env };
    const childEnv = spikeGitEnvironment(source);

    expect(childEnv.GIT_DIR).toBeUndefined();
    expect(childEnv.GIT_WORK_TREE).toBeUndefined();
    expect(childEnv.GIT_INDEX_FILE).toBeUndefined();
    expect(childEnv.KEEP_ME).toBe("preserved");
    expect(childEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(source.GIT_DIR).toBe("/other/repo/.git");
    expect(process.env).toEqual(before);
  });
});

describe.each(variants)("spike: $name", (v) => {
  function run(fx: Fixture) {
    const patch = git(fx.repo, v.patchArgs(fx.F)).out;
    const patchDir = mkdtempSync(join(tmpdir(), "hades-spike-patch-"));
    tmpRoots.push(patchDir);
    const patchFile = join(patchDir, "fix.patch");
    writeFileSync(patchFile, patch);

    const wt = join(mkdtempSync(join(tmpdir(), "hades-spike-wt-")), "wt");
    tmpRoots.push(join(wt, ".."));
    git(fx.repo, ["worktree", "add", "--detach", wt, fx.L]);
    const res = git(wt, [...v.applyArgs, patchFile], true);
    return { wt, res };
  }

  it("clean case: exit 0 and expected content", () => {
    const fx = buildRepo(false);
    const { wt, res } = run(fx);
    expect(res.code, res.err).toBe(0);
    const unmerged = git(wt, ["diff", "--name-only", "--diff-filter=U"]).out.trim();
    expect(unmerged).toBe("");
    expect(readFileSync(join(wt, "src", "a.js"), "utf8")).toBe(fx.expected);
    expect(git(wt, ["status", "--porcelain"]).code).toBe(0);
    expect(git(fx.repo, ["worktree", "remove", "--force", wt]).code).toBe(0);
  });

  it("conflict case: non-zero exit and unmerged path", () => {
    const fx = buildRepo(true);
    const { wt, res } = run(fx);
    expect(res.code, res.err).not.toBe(0);
    const unmerged = git(wt, ["diff", "--name-only", "--diff-filter=U"]).out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(unmerged).toContain("src/a.js");
    expect(git(wt, ["status", "--porcelain"]).code).toBe(0);
    expect(git(fx.repo, ["worktree", "remove", "--force", wt]).code).toBe(0);
  });
});

// keep execFileSync import used for version capture in the report
it("records git version", () => {
  const v = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  console.log(`SPIKE git version: ${v}`);
  expect(v).toMatch(/^git version/);
});
