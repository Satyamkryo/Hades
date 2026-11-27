import { homedir } from "node:os";
import path from "node:path";

/**
 * True when `file` is the repo root itself or a relative descendant of it.
 * Outside destinations (`..`, `../...`) and absolute results (different
 * Windows drives) are not inside.
 */
export function isInsideRepo(repo: string, file: string): boolean {
  const rel = path.relative(path.resolve(repo), path.resolve(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Build `~/.hades/history/<name>-<short sha>-<timestamp>.json`.
 * Throws if the resulting path would be inside the target repo.
 */
export function historyPath(
  repo: string,
  headSha: string | null,
  now: Date = new Date(),
  home: string = homedir(),
): string {
  const name = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.resolve(
    home,
    ".hades",
    "history",
    `${name}-${headSha?.slice(0, 7) ?? "empty"}-${stamp}.json`,
  );
  if (isInsideRepo(repo, file)) {
    throw new Error(`Refusing to write history inside the target repo: ${file}`);
  }
  return file;
}
