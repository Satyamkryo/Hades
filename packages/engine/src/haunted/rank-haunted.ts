import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HauntedFile, HauntedReport } from "../ask/types.js";
import { HadesConfigError } from "../errors.js";
import { existingCommits } from "../git/verify-shas.js";
import { validateRepo } from "../repo/validate.js";
import { readEscapedSouls } from "./escaped.js";
import { scanRepoHistory } from "./scan.js";
import { scoreFiles } from "./score.js";

export interface RankHauntedOptions {
  maxCommits?: number;
  top?: number;
  extraTestPatterns?: string[];
  extraNonCodePatterns?: string[];
}

export interface HauntedDeps {
  /** Cache home holding `reports/`; defaults to `~/.hades`. */
  hadesHome?: string;
}

const rankHauntedSchema = z
  .object({
    maxCommits: z.number().int().positive().default(500),
    top: z.number().int().positive().default(10),
    extraTestPatterns: z.array(z.string().trim().min(1)).default([]),
    extraNonCodePatterns: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

/**
 * Rank source files by their fix history: files with the most fixes, reverts
 * and churn come first. Read-only: two git calls plus validation and one SHA
 * check. No cache: the calls are cheap and the counts are recomputed anyway.
 */
export async function rankHaunted(
  repo: string,
  options: RankHauntedOptions = {},
  deps: HauntedDeps = {},
): Promise<HauntedReport> {
  const hadesHome = deps.hadesHome ?? join(homedir(), ".hades");
  const parsed = rankHauntedSchema.safeParse(options);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "options"}: ${i.message}`)
      .join("; ");
    throw new HadesConfigError(`Invalid options: ${detail}`);
  }
  const opts = parsed.data;

  const validated = await validateRepo(repo);
  const head = validated.baseSha ?? null;
  if (head === null) {
    return {
      repo: validated.repo,
      headSha: null,
      commitsScanned: 0,
      files: [],
      warnings: ["repo has no commits"],
    };
  }

  const { commits, headPaths } = await scanRepoHistory(validated.repo, opts.maxCommits, head);
  const scored = scoreFiles(commits, headPaths, {
    top: opts.top,
    extraTestPatterns: opts.extraTestPatterns,
    extraNonCodePatterns: opts.extraNonCodePatterns,
  });

  const escaped = await readEscapedSouls(validated.repo, hadesHome);
  const escapedShas = [...escaped.byFile.values()].flat();
  const allShas = [...scored.flatMap((f) => [...f.fixShas, ...f.revertShas]), ...escapedShas];
  const existing = await existingCommits(validated.repo, allShas);
  const warnings: string[] = [...escaped.warnings];
  const dropped = allShas.filter((sha) => !existing.has(sha));
  if (dropped.length > 0) {
    warnings.push(`dropped ${dropped.length} unverified SHAs: ${dropped.join(", ")}`);
  }
  const files: HauntedFile[] = scored.map((f) => {
    const souls = (escaped.byFile.get(f.path) ?? []).filter((sha) => existing.has(sha));
    return {
      path: f.path,
      score: f.score,
      fixes: f.fixes,
      reverts: f.reverts,
      churn: f.churn,
      fixShas: f.fixShas.filter((sha) => existing.has(sha)),
      revertShas: f.revertShas.filter((sha) => existing.has(sha)),
      ...(souls.length > 0 ? { escapedSouls: souls } : {}),
    };
  });
  return {
    repo: validated.repo,
    headSha: head,
    commitsScanned: commits.length,
    files,
    ...(escaped.report !== undefined ? { report: escaped.report } : {}),
    warnings,
  };
}
