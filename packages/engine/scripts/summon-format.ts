import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnderworldReport } from "../src/index.js";

export const CTRL_C_NOTE =
  "Summoning runs the repo's own test scripts in temporary worktrees. " +
  "Press Ctrl+C to stop; leftover worktrees will be listed with cleanup commands.";

const shortSha = (sha: string): string => sha.slice(0, 7);

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

/** Human-readable summary of a report, one string per output line. */
export function formatSummary(
  report: UnderworldReport,
  given: { testCommand?: boolean } = {},
): string[] {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`Repo: ${report.repo}`);
  lines.push(`Base: ${shortSha(report.baseSha)}  Status: ${report.status}`);
  // report.options is already redacted by the engine.
  const command =
    report.status === "no-tests" && !given.testCommand
      ? "none (no test script in package.json)"
      : `${report.options.testCommand}${given.testCommand ? "" : " (default)"}`;
  lines.push(`test command: ${command}`);
  lines.push(`timeout: ${report.options.timeoutMs / 1000}s`);
  lines.push(
    `Totals: scanned ${t.commitsScanned}, candidates ${t.candidates}, ` +
      `rejected ${t.rejectedByLlm}, llm errors ${t.llmErrors}, unchecked ${t.unchecked}, ` +
      `processed ${t.processed}, escaped ${t.escaped}, buried ${t.buried}, lost ${t.lost}`,
  );
  for (const w of report.warnings) lines.push(`Warning: ${w}`);

  if (report.status === "baseline-failed") {
    lines.push(`Baseline failed: ${report.baseline?.reason ?? "unknown reason"}`);
    if (report.baseline?.excerpt) lines.push(report.baseline.excerpt);
    return lines;
  }
  if (report.status === "no-tests") {
    lines.push(`No test suite. ${t.unguarded} past fixes are unguarded.`);
    for (const u of report.unguarded) {
      lines.push(`  unguarded ${shortSha(u.sha)} ${firstLine(u.message)} [${u.files.join(", ")}]`);
    }
    return lines;
  }
  for (const e of report.entries) {
    const lost = e.lostReason !== undefined ? ` (${e.lostReason})` : "";
    lines.push(
      `  ${e.label} ${shortSha(e.sha)} ${firstLine(e.message)} ` +
        `[reverted: ${e.filesReverted.join(", ") || "none"}]${lost}`,
    );
  }
  return lines;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function canonicalExistingPath(value: string): string {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      current = resolved;
      for (let i = missing.length - 1; i >= 0; i--) {
        current = path.join(current, missing[i]!);
      }
      return path.resolve(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Build `<reportsDir>/<name>-<short sha>-<timestamp>.json`.
 * Throws if the resulting path would be inside the target repo.
 */
export function reportPath(
  repo: string,
  baseSha: string,
  now: Date = new Date(),
  home: string = os.homedir(),
): string {
  const name = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.resolve(home, ".hades", "reports", `${name}-${shortSha(baseSha) || "empty"}-${stamp}.json`);
  if (isInside(canonicalExistingPath(repo), canonicalExistingPath(file))) {
    throw new Error(`Refusing to write the report inside the target repo: ${file}`);
  }
  return file;
}

export function exitCodeFor(status: UnderworldReport["status"]): number {
  return status === "baseline-failed" ? 2 : 0;
}
