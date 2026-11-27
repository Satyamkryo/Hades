import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** Lower-case on Windows so `E:\\Repo` and `e:\\repo` share one cache file. */
export function canonicalRoot(repoRoot: string): string {
  const real = realpathSync.native(repoRoot);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Stable id for the cache file name: SHA-256 of the canonical repo root,
 * first 16 hex chars. One file per repo under `~/.hades/`.
 */
export function repoId(repoRoot: string): string {
  return createHash("sha256").update(canonicalRoot(repoRoot)).digest("hex").slice(0, 16);
}
