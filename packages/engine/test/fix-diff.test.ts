import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParentUnavailableError } from "../src/errors.js";
import { changedFiles, diffSummary, fixPatch } from "../src/history/fix-diff.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function track(r: TestRepo): TestRepo {
  cleanups.push(r.cleanup);
  return r;
}

describe("fix-diff", () => {
  it("lists paths with spaces and glob characters and builds a literal-path patch", async () => {
    // `*` is not a legal filename character on Windows; `[x]` is a glob there too.
    const g = process.platform === "win32" ? "s[x]r.txt" : "s*r.txt";
    const repo = track(
      makeRepo([
        { message: "init", files: { "a b.txt": "1\n", [g]: "1\n", "sxr.txt": "1\n" } },
        { message: "fix", files: { "a b.txt": "2\n", [g]: "2\n", "sxr.txt": "2\n" } },
      ]),
    );
    const sha = repo.shas[1]!;
    const files = await changedFiles(repo.dir, sha);
    expect(files.sort()).toEqual(["a b.txt", g, "sxr.txt"]);

    const patch = await fixPatch(repo.dir, sha, [g]);
    expect(patch).toContain(g);
    expect(patch).not.toContain("sxr.txt"); // `*` was not treated as a glob
    const patch2 = await fixPatch(repo.dir, sha, ["a b.txt"]);
    expect(patch2).toContain("a b.txt");
  });

  it("shows a src/ -> test/ rename as delete + add", async () => {
    const repo = track(
      makeRepo([
        { message: "init", files: { "src/x.ts": "export const x = 1;\nline2\nline3\n" } },
        {
          message: "move",
          files: { "src/x.ts": null, "test/x.ts": "export const x = 1;\nline2\nline3\n" },
        },
      ]),
    );
    const files = await changedFiles(repo.dir, repo.shas[1]!);
    expect(files.sort()).toEqual(["src/x.ts", "test/x.ts"]);
  });

  it("includes binary content in the patch", async () => {
    const bin = Buffer.from([0, 1, 2, 3, 255, 0, 9]);
    const bin2 = Buffer.from([0, 1, 2, 4, 254, 0, 9]);
    const repo = track(
      makeRepo([
        { message: "init", files: { "img.bin": bin } },
        { message: "fix", files: { "img.bin": bin2 } },
      ]),
    );
    const patch = await fixPatch(repo.dir, repo.shas[1]!, ["img.bin"]);
    expect(patch).toContain("GIT binary patch");
    expect(patch).toMatch(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/);
  });

  it("does not apply textconv filters to source patches", async () => {
    const repo = track(
      makeRepo([
        {
          message: "init",
          files: {
            ".gitattributes": "*.txt diff=source\n",
            "textconv.mjs": 'import fs from "node:fs"; process.stdout.write("TEXTCONVERTED\\n");\n',
            "a.txt": "actual before\n",
          },
        },
        {
          message: "fix",
          files: { "a.txt": "actual after\n" },
        },
      ]),
    );
    git(repo.dir, "config", "diff.source.textconv", "node textconv.mjs");
    const patch = await fixPatch(repo.dir, repo.shas[1]!, ["a.txt"]);
    expect(patch).toContain("actual before");
    expect(patch).toContain("actual after");
    expect(patch).not.toContain("TEXTCONVERTED");
  });

  it("does not include ANSI color sequences in source patches", async () => {
    const repo = track(
      makeRepo([
        { message: "init", files: { "a.txt": "before\n" } },
        { message: "fix", files: { "a.txt": "after\n" } },
      ]),
    );
    git(repo.dir, "config", "color.diff", "always");
    const patch = await fixPatch(repo.dir, repo.shas[1]!, ["a.txt"]);
    expect(patch).toContain("before");
    expect(patch).toContain("after");
    expect(patch).not.toMatch(/\u001b\[/);
  });

  it("diffSummary is cut to maxChars", async () => {
    const repo = track(
      makeRepo([
        { message: "init", files: { "a.txt": "x\n" } },
        { message: "fix", files: { "a.txt": "y\n".repeat(2000) } },
      ]),
    );
    const s = await diffSummary(repo.dir, repo.shas[1]!, 100);
    expect(s.length).toBe(100);
    expect(s).toContain("a.txt");
  });

  it("reports a missing parent (root commit)", async () => {
    const repo = track(makeRepo([{ message: "init", files: { "a.txt": "x\n" } }]));
    const sha = repo.shas[0]!;
    for (const call of [
      () => changedFiles(repo.dir, sha),
      () => fixPatch(repo.dir, sha, ["a.txt"]),
      () => diffSummary(repo.dir, sha),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ParentUnavailableError);
      expect((err as Error).message).toBe("parent commit not available");
    }
  });

  it("reports a missing parent in a shallow clone", async () => {
    const repo = track(
      makeRepo([
        { message: "init", files: { "a.txt": "1\n" } },
        { message: "fix", files: { "a.txt": "2\n" } },
      ]),
    );
    const parent = mkdtempSync(path.join(os.tmpdir(), "hades-shallow-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const dest = path.join(parent, "clone");
    // file:// is needed: a plain local path ignores --depth.
    git(parent, "clone", "-q", "--depth", "1", `file://${repo.dir.replace(/\\/g, "/")}`, dest);
    await expect(changedFiles(dest, repo.shas[1]!)).rejects.toBeInstanceOf(ParentUnavailableError);
  });
});
