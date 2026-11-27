import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCallCount } from "../src/git/exec.js";
import { rankHaunted } from "../src/haunted/rank-haunted.js";
import { makeRepo } from "./helpers/repo.js";

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const A_V1 = "export const a = 1;\n";
const A_V2 = "export const a = 2;\n";
const B_V1 = "export const b = 1;\n";

function makeHauntedRepo() {
  return makeRepo([
    { message: "fix crash in a", files: { "src/a.ts": A_V1, "src/b.ts": B_V1 } },
    { message: "fix a again", files: { "src/a.ts": A_V2 } },
  ]);
}

function writeReport(dir: string, name: string, data: unknown, mtimeMs: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  const t = new Date(mtimeMs);
  // utimesSync sets atime+mtime; mtime is what the engine sorts by.
  utimesSync(file, t, t);
  return file;
}

function snapshotMtimes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  out.set(".", statSync(dir).mtimeMs);
  for (const name of readdirSync(dir)) {
    out.set(name, statSync(path.join(dir, name)).mtimeMs);
  }
  return out;
}

describe("rankHaunted escaped souls", () => {
  it("adds escapedSouls from the newest matching report only, skips invalid reports, leaves mtimes unchanged", async () => {
    const repo = makeHauntedRepo();
    const home = makeTemp("hades-home-");
    const reportsDir = path.join(home, "reports");
    mkdirSync(reportsDir, { recursive: true });
    try {
      const [fixSha] = repo.shas;
      const fakeSha = "a".repeat(40);
      const now = Date.now();

      // Older matching report: must lose to the newer one.
      writeReport(
        reportsDir,
        "old-match.json",
        {
          status: "ok",
          repo: repo.dir,
          baseSha: repo.shas[repo.shas.length - 1],
          entries: [{ sha: fixSha, message: "fix", label: "escaped", filesReverted: ["src/b.ts"] }],
        },
        now - 3000,
      );
      // Non-matching repo: ignored, no warning.
      writeReport(
        reportsDir,
        "other-repo.json",
        {
          repo: path.join(tmpdir(), "some-other-repo"),
          entries: [{ sha: fixSha, label: "escaped", filesReverted: ["src/a.ts"] }],
        },
        now - 2000,
      );
      // Invalid JSON: skipped with a warning.
      writeReport(reportsDir, "bad-json.json", "{not json", now - 1500);
      // Invalid schema (entries missing): skipped with a warning.
      writeReport(reportsDir, "bad-schema.json", { repo: repo.dir, nope: true }, now - 1000);
      // Newest matching report: wins. Includes one unverified SHA.
      writeReport(
        reportsDir,
        "new-match.json",
        {
          repo: repo.dir,
          entries: [
            { sha: fixSha, message: "fix", label: "escaped", filesReverted: ["src/a.ts"], extra: 1 },
            { sha: fixSha, message: "fix", label: "buried", filesReverted: ["src/a.ts"] },
            { sha: fakeSha, message: "fix", label: "escaped", filesReverted: ["src/a.ts"] },
          ],
        },
        now,
      );

      const before = snapshotMtimes(reportsDir);
      const beforeCalls = gitCallCount();
      const report = await rankHaunted(repo.dir, {}, { hadesHome: home });
      const after = snapshotMtimes(reportsDir);

      expect(after).toEqual(before);
      expect(readdirSync(reportsDir).sort()).toEqual(
        ["bad-json.json", "bad-schema.json", "new-match.json", "old-match.json", "other-repo.json"].sort(),
      );
      // No extra git calls: escaped souls are file reads only (6 total).
      expect(gitCallCount() - beforeCalls).toBe(6);

      expect(report.report).toBe("new-match.json");
      const byPath = new Map(report.files.map((f) => [f.path, f]));
      // Newest match wins: src/a.ts from new-match, not src/b.ts from old-match.
      expect(byPath.get("src/a.ts")?.escapedSouls).toEqual([fixSha]);
      expect(byPath.get("src/b.ts")?.escapedSouls).toBeUndefined();
      // Unverified escaped SHA is dropped and named.
      expect(report.warnings.some((w) => w.includes(fakeSha))).toBe(true);
      // Invalid reports each add one warning naming the file.
      expect(report.warnings.some((w) => w.includes("bad-json.json"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("bad-schema.json"))).toBe(true);
      // Counts stay as computed from git.
      expect(byPath.get("src/a.ts")).toMatchObject({ fixes: 2, churn: 2 });
    } finally {
      repo.cleanup();
    }
  });

  it("omits escapedSouls and report when no report matches", async () => {
    const repo = makeHauntedRepo();
    const home = makeTemp("hades-home-");
    const reportsDir = path.join(home, "reports");
    mkdirSync(reportsDir, { recursive: true });
    try {
      writeReport(
        reportsDir,
        "other.json",
        { repo: path.join(tmpdir(), "elsewhere"), entries: [] },
        Date.now(),
      );
      const before = snapshotMtimes(reportsDir);
      const report = await rankHaunted(repo.dir, {}, { hadesHome: home });
      expect(snapshotMtimes(reportsDir)).toEqual(before);
      expect(report.report).toBeUndefined();
      expect(report.files.every((f) => f.escapedSouls === undefined)).toBe(true);
      expect(report.warnings).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });

  it("works with no reports dir at all", async () => {
    const repo = makeHauntedRepo();
    const home = makeTemp("hades-home-");
    try {
      const report = await rankHaunted(repo.dir, {}, { hadesHome: home });
      expect(report.report).toBeUndefined();
      expect(report.files.every((f) => f.escapedSouls === undefined)).toBe(true);
      expect(report.warnings).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
