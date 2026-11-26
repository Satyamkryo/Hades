import { afterEach, describe, expect, it } from "vitest";
import { hasTestSuite } from "../src/repo/test-suite.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

// Every repo made in a test is kept, because some tests call check() more than once.
const repos: TestRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

async function check(files: Record<string, string | null>): Promise<boolean> {
  const repo = makeRepo([{ message: "init", files }]);
  repos.push(repo);
  return hasTestSuite(repo.dir, repo.shas[0]!);
}

describe("hasTestSuite", () => {
  it("is false without package.json", async () => {
    expect(await check({ "a.txt": "x" })).toBe(false);
  });

  it("is false without scripts or scripts.test", async () => {
    expect(await check({ "package.json": "{}" })).toBe(false);
    expect(await check({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) })).toBe(false);
  });

  it("is false for empty or non-string scripts.test", async () => {
    expect(await check({ "package.json": JSON.stringify({ scripts: { test: "  " } }) })).toBe(false);
    expect(await check({ "package.json": JSON.stringify({ scripts: { test: 5 } }) })).toBe(false);
    expect(await check({ "package.json": JSON.stringify({ scripts: "x" }) })).toBe(false);
  });

  it("is false for npm's default placeholder", async () => {
    const test = 'echo "Error: no test specified" && exit 1';
    expect(await check({ "package.json": JSON.stringify({ scripts: { test } }) })).toBe(false);
  });

  it("does not reject real test commands containing placeholder text", async () => {
    expect(await check({
      "package.json": JSON.stringify({
        scripts: { test: 'vitest run --reporter "no test specified"' },
      }),
    })).toBe(true);
    expect(await check({
      "package.json": JSON.stringify({
        scripts: { test: 'echo "no test specified"; vitest run' },
      }),
    })).toBe(true);
  });

  it("is true for a real script", async () => {
    expect(await check({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) })).toBe(true);
  });

  it("is true for invalid JSON", async () => {
    expect(await check({ "package.json": "{ not json" })).toBe(true);
  });

  it("reads the committed file, not the working copy", async () => {
    const repo = makeRepo([{ message: "init", files: { "package.json": "{}" } }]);
    repos.push(repo);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${repo.dir}/package.json`, JSON.stringify({ scripts: { test: "jest" } }));
    expect(await hasTestSuite(repo.dir, repo.shas[0]!)).toBe(false);
  });
});
