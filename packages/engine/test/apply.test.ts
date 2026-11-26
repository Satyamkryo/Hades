import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixPatch } from "../src/history/fix-diff.js";
import { reverseApply } from "../src/summon/apply.js";
import { createWorktree, removeWorktree } from "../src/summon/worktree.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

const lines = (edits: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? `line${i + 1}`).join("\n") + "\n";

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function run(laterEdits: Record<number, string>) {
  repo = makeRepo([
    { message: "base", files: { "src/a.js": lines() } },
    { message: "fix bug", files: { "src/a.js": lines({ 10: "line10 FIXED" }) } },
    { message: "later", files: { "src/a.js": lines({ 10: "line10 FIXED", ...laterEdits }) } },
  ]);
  const [, fix, later] = repo.shas as [string, string, string];
  const patch = await fixPatch(repo.dir, fix, ["src/a.js"]);
  const wt = await createWorktree(repo.dir, later);
  try {
    const result = await reverseApply(wt, patch);
    const content = readFileSync(path.join(wt, "src", "a.js"), "utf8");
    return { result, content, wt };
  } finally {
    await removeWorktree(repo.dir, wt);
  }
}

describe("reverseApply", () => {
  it("undoes a fix cleanly even when nearby context drifted", async () => {
    const { result, content } = await run({ 8: "line8 LATER", 12: "line12 LATER" });
    expect(result).toEqual({ ok: true });
    expect(content).toBe(lines({ 8: "line8 LATER", 12: "line12 LATER" }));
  });

  it("returns 'revert did not apply' with stderr when the fixed line was rewritten", async () => {
    const { result } = await run({ 10: "line10 REWRITTEN LATER" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revert did not apply");
      expect(result.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("leaves the real working tree untouched", async () => {
    const { result } = await run({ 10: "line10 REWRITTEN LATER" });
    expect(result.ok).toBe(false);
    expect(git(repo!.dir, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(path.join(repo!.dir, "src", "a.js"), "utf8")).toBe(
      lines({ 10: "line10 REWRITTEN LATER" }),
    );
  });
});
