import { afterEach, describe, expect, it } from "vitest";
import { changesDependencies } from "../src/history/dependency-change.js";
import { makeRepo, type CommitSpec, type TestRepo } from "./helpers/repo.js";

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

/** Two commits: `before` then `after` for the path; returns the result for the second. */
function check(
  before: string | null,
  after: string | null,
  file = "package.json",
): Promise<boolean> {
  const commits: CommitSpec[] = [
    { message: "init", files: before === null ? { "x.txt": "1" } : { [file]: before } },
    { message: "fix", files: { [file]: after } },
  ];
  const r = makeRepo(commits);
  repos.push(r);
  return changesDependencies(r.dir, r.shas[1]!, [file]);
}

const pkg = (o: object) => JSON.stringify(o) + "\n";

describe("changesDependencies", () => {
  it("lockfile always counts", async () => {
    expect(await check("a\n", "b\n", "yarn.lock")).toBe(true);
    expect(await check("{}", "{}", "sub/package-lock.json")).toBe(true);
  });

  it.each([
    ["version", { version: "1.0.0" }, { version: "1.0.1" }],
    ["exports", { main: "a.js" }, { main: "b.js", exports: "./b.js" }],
    ["types", {}, { types: "index.d.ts" }],
    ["scripts", { scripts: { test: "a" } }, { scripts: { test: "b" } }],
  ])("package.json %s change does not count", async (_n, a, b) => {
    expect(await check(pkg(a), pkg(b))).toBe(false);
  });

  it("ignores key order inside a dependency field", async () => {
    const a = '{"dependencies":{"a":"1","b":"2"}}';
    const b = '{"dependencies":{"b":"2","a":"1"}}';
    expect(await check(a, b)).toBe(false);
  });

  it.each([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
    "overrides",
    "resolutions",
  ])("%s change counts", async (field) => {
    expect(await check(pkg({}), pkg({ [field]: field === "bundleDependencies" ? ["a"] : { a: "1" } }))).toBe(true);
  });

  it("added, deleted or invalid-JSON package.json counts", async () => {
    expect(await check(null, "{}\n")).toBe(true);
    expect(await check("{}\n", null)).toBe(true);
    expect(await check("{}\n", "{ nope")).toBe(true);
    expect(await check("{}\n", "[1]\n")).toBe(true);
  });

  it("false when no dependency files are listed", async () => {
    const r = makeRepo([{ message: "a", files: { "a.js": "1" } }, { message: "b", files: { "a.js": "2" } }]);
    repos.push(r);
    expect(await changesDependencies(r.dir, r.shas[1]!, ["a.js"])).toBe(false);
  });
});
