import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exitCodeFor, formatSummary, reportPath } from "../scripts/summon-format.js";
import type { UnderworldReport } from "../src/index.js";

const sha = "a".repeat(40);
const totals = {
  commitsScanned: 3, candidates: 2, rejectedByLlm: 0, llmErrors: 0, unchecked: 0,
  staleCleaned: 0, processed: 1, escaped: 1, buried: 0, lost: 0, unguarded: 2,
};
const base = {
  repo: "/r", baseSha: sha, warnings: [], entries: [], unguarded: [], rejected: [],
  llmErrors: [], totals, options: { testCommand: "npm test", timeoutMs: 120000 }, droppedUnverified: [], deps: { method: "none", workspace: false },
} as unknown as UnderworldReport;

describe("summon script helpers", () => {
  it("prints test command and timeout in the header", () => {
    const okOut = formatSummary({ ...base, status: "ok" }).join("\n");
    expect(okOut).toContain("test command: npm test (default)");
    expect(okOut).toContain("timeout: 120s");
    expect(formatSummary({ ...base, status: "ok" }, { testCommand: true }).join("\n")).toContain("test command: npm test\n");
    expect(formatSummary({ ...base, status: "no-tests" }).join("\n")).toContain(
      "test command: none (no test script in package.json)",
    );
  });

  it("formats entries with short sha, files and lost reason", () => {
    const lines = formatSummary({
      ...base,
      status: "ok",
      entries: [
        { sha, message: "fix x\nbody", label: "lost", lostReason: "timeout", filesReverted: ["src/a.js"] },
      ],
    } as UnderworldReport);
    expect(lines.join("\n")).toContain("lost aaaaaaa fix x [reverted: src/a.js] (timeout)");
  });

  it("prints the no-tests line and baseline details", () => {
    expect(formatSummary({ ...base, status: "no-tests" }).join("\n")).toContain(
      "No test suite. 2 past fixes are unguarded.",
    );
    const out = formatSummary({
      ...base,
      status: "baseline-failed",
      baseline: { passed: false, reason: "tests fail", excerpt: "boom" },
    }).join("\n");
    expect(out).toContain("tests fail");
    expect(out).toContain("boom");
  });

  it("maps status to exit code", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("no-tests")).toBe(0);
    expect(exitCodeFor("baseline-failed")).toBe(2);
  });

  it("builds the report path and refuses one inside the repo", () => {
    const home = path.resolve("/home/u");
    const p = reportPath("/work/proj", sha, new Date("2024-01-02T03:04:05.678Z"), home);
    expect(p).toBe(path.join(home, ".hades", "reports", "proj-aaaaaaa-2024-01-02T03-04-05-678Z.json"));
    expect(() => reportPath(home, sha, new Date(), home)).toThrow(/Refusing/);
    expect(() => reportPath(home, sha, new Date(), path.join(home, "..reports"))).toThrow(/Refusing/);
    expect(() => reportPath(path.join(home, "repo"), sha, new Date(), home)).not.toThrow();
  });

  it("rejects destinations reached through an existing symlink ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hades-report-path-"));
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    try {
      fs.symlinkSync(repo, path.join(home, ".hades"), "junction");
      expect(() => reportPath(repo, sha, new Date(), home)).toThrow(/Refusing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
