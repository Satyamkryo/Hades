import { runGit } from "../git/exec.js";
import type { ReportTotals, UnderworldReport } from "./types.js";

/** Totals that come from the scan, confirm and cleanup phases (not from the lists). */
export type PhaseTotals = Pick<
  ReportTotals,
  "commitsScanned" | "candidates" | "rejectedByLlm" | "llmErrors" | "unchecked" | "staleCleaned"
>;

/** A report before verification: no totals and no dropped list yet. */
export type UnverifiedReport = Omit<UnderworldReport, "totals" | "droppedUnverified">;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** True when `sha` is a full SHA of a commit that exists in the repo. */
export async function commitExists(repo: string, sha: string): Promise<boolean> {
  if (!FULL_SHA.test(sha)) return false;
  const result = await runGit(repo, ["cat-file", "-t", sha], { allowFail: true });
  return result.code === 0 && result.stdout.trim() === "commit";
}

/**
 * Verify every SHA in the report (entries, rejected, llmErrors, unguarded, baseSha), drop
 * items whose commit does not exist, and compute totals. Entry and unguarded totals are
 * derived after dropping, so they cannot drift from the lists.
 *
 * A bad baseSha cannot be dropped: it is listed in droppedUnverified and a warning is added.
 */
export async function verifyAndTotal(
  repo: string,
  report: UnverifiedReport,
  phase: PhaseTotals,
): Promise<UnderworldReport> {
  const dropped: string[] = [];
  const cache = new Map<string, Promise<boolean>>();
  const exists = (sha: string): Promise<boolean> => {
    let known = cache.get(sha);
    if (!known) {
      known = commitExists(repo, sha);
      cache.set(sha, known);
    }
    return known;
  };

  async function keepVerified<T extends { sha: string }>(items: T[]): Promise<T[]> {
    const flags = await Promise.all(items.map((item) => exists(item.sha)));
    const kept: T[] = [];
    items.forEach((item, i) => {
      if (flags[i]) kept.push(item);
      else dropped.push(item.sha);
    });
    return kept;
  }

  const entries = await keepVerified(report.entries);
  const rejected = await keepVerified(report.rejected);
  const llmErrors = await keepVerified(report.llmErrors);
  const unguarded = await keepVerified(report.unguarded);

  const warnings = [...report.warnings];
  if (!(await exists(report.baseSha))) {
    dropped.push(report.baseSha);
    warnings.push(`base commit ${report.baseSha} could not be verified in the repo`);
  }

  const count = (label: "escaped" | "buried" | "lost"): number =>
    entries.filter((e) => e.label === label).length;

  return {
    ...report,
    warnings,
    entries,
    rejected,
    llmErrors,
    unguarded,
    totals: {
      ...phase,
      processed: entries.length,
      escaped: count("escaped"),
      buried: count("buried"),
      lost: count("lost"),
      unguarded: unguarded.length,
    },
    droppedUnverified: dropped,
  };
}
