import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalRoot } from "../cache/repo-id.js";

/**
 * Minimal summoning-report shape for escaped souls. Everything else in the
 * report is ignored (passthrough), so future report fields never break this.
 */
const escapedReportSchema = z
  .object({
    repo: z.string(),
    entries: z.array(
      z
        .object({
          sha: z.string(),
          label: z.string(),
          filesReverted: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface EscapedSoulsResult {
  /** Escaped SHAs per file path, from the newest matching report. */
  byFile: Map<string, string[]>;
  /** File name (not path) of the summoning report used, if any. */
  report?: string;
  warnings: string[];
}

/** Normalise a repo path the same way as `repoId` (no throw for missing paths). */
function safeCanonical(value: string): string {
  try {
    return canonicalRoot(value);
  } catch {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

/**
 * Read escaped souls from the newest matching summoning report in
 * `<hadesHome>/reports/`. Read-only: only `readdir`, `stat` and `readFile`
 * are used, so directory and file mtimes are left unchanged.
 *
 * - Newest 50 `*.json` files by mtime are considered.
 * - Reports whose `repo` does not normalise to `repoRoot` are ignored.
 * - Unreadable or invalid reports are skipped with one warning each.
 */
export async function readEscapedSouls(
  repoRoot: string,
  hadesHome: string,
): Promise<EscapedSoulsResult> {
  const warnings: string[] = [];
  const byFile = new Map<string, string[]>();
  const reportsDir = path.join(hadesHome, "reports");

  let names: string[];
  try {
    names = await readdir(reportsDir);
  } catch (error) {
    // No reports dir yet: no report, no warning.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { byFile, warnings };
    }
    warnings.push(
      `skipped summoning reports: cannot list ${reportsDir}: ${(error as Error).message}`,
    );
    return { byFile, warnings };
  }

  const jsonNames = names.filter((n) => n.endsWith(".json"));
  if (jsonNames.length === 0) {
    return { byFile, warnings };
  }

  const withMtime: { name: string; mtimeMs: number }[] = [];
  for (const name of jsonNames) {
    try {
      const st = await stat(path.join(reportsDir, name));
      withMtime.push({ name, mtimeMs: st.mtimeMs });
    } catch (error) {
      warnings.push(`skipped summoning report ${name}: ${(error as Error).message}`);
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = withMtime.slice(0, 50);

  const wanted = safeCanonical(repoRoot);
  let matchedName: string | undefined;
  let matchedEntries:
    | { sha: string; label: string; filesReverted: string[] }[]
    | undefined;

  for (const { name } of newest) {
    let text: string;
    try {
      text = await readFile(path.join(reportsDir, name), "utf8");
    } catch (error) {
      warnings.push(`skipped summoning report ${name}: ${(error as Error).message}`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch (error) {
      warnings.push(`skipped summoning report ${name}: invalid JSON (${(error as Error).message})`);
      continue;
    }
    const parsed = escapedReportSchema.safeParse(json);
    if (!parsed.success) {
      warnings.push(`skipped summoning report ${name}: invalid report`);
      continue;
    }
    if (matchedName !== undefined) {
      continue;
    }
    if (safeCanonical(parsed.data.repo) === wanted) {
      matchedName = name;
      matchedEntries = parsed.data.entries;
    }
  }

  if (matchedName === undefined || matchedEntries === undefined) {
    return { byFile, warnings };
  }

  for (const entry of matchedEntries) {
    if (entry.label !== "escaped") {
      continue;
    }
    for (const file of entry.filesReverted) {
      const list = byFile.get(file);
      if (list === undefined) {
        byFile.set(file, [entry.sha]);
      } else if (!list.includes(entry.sha)) {
        list.push(entry.sha);
      }
    }
  }
  return { byFile, report: matchedName, warnings };
}
