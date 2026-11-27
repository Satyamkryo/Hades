import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askHistory } from "../src/ask/ask-history.js";
import { gitCallCount } from "../src/git/exec.js";
import { createFakeGithub } from "./helpers/fake-github.js";
import { makeRepo } from "./helpers/repo.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

/** Repo with `n` commits, each changing the body of `add` in calc.c. */
function makeSizedRepo(n: number): { dir: string; cleanup: () => void } {
  const specs = Array.from({ length: n }, (_, i) => ({
    message: `change ${i}`,
    files: { "calc.c": `int add(int a, int b) {\n  return ${i};\n}\n` },
  }));
  return makeRepo(specs);
}

describe("askHistory git call budget", () => {
  it("uses the same few calls for 1, 10 and 50 commits", async () => {
    const counts: number[] = [];
    for (const n of [1, 10, 50]) {
      const repo = makeSizedRepo(n);
      const home = tempDir("hades-home-");
      try {
        const fake = createFakeGithub();
        const before = gitCallCount();
        const answer = await askHistory(
          repo.dir,
          "calc.c",
          { lines: [1, 2], symbol: "add" },
          { github: fake.client, llm: null, hadesHome: home },
        );
        counts.push(gitCallCount() - before);
        expect(answer.commits).toHaveLength(n);
        expect(answer.blame.length).toBeGreaterThan(0);
        expect(answer.warnings).toEqual([]);
      } finally {
        repo.cleanup();
      }
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
    expect(counts[0]).toBeLessThanOrEqual(10);
  });

  it("uses fewer calls on a warm cache", async () => {
    const repo = makeSizedRepo(10);
    const home = tempDir("hades-home-");
    try {
      const fake = createFakeGithub();
      const deps = { github: fake.client, llm: null, hadesHome: home } as const;
      const beforeCold = gitCallCount();
      await askHistory(repo.dir, "calc.c", { lines: [1, 2], symbol: "add" }, { ...deps });
      const cold = gitCallCount() - beforeCold;

      const beforeWarm = gitCallCount();
      const warm = await askHistory(repo.dir, "calc.c", { lines: [1, 2], symbol: "add" }, { ...deps });
      const warmCalls = gitCallCount() - beforeWarm;

      expect(warmCalls).toBeLessThan(cold);
      expect(warm.commits).toHaveLength(10);
    } finally {
      repo.cleanup();
    }
  });
});
