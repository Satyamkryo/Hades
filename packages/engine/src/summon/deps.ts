import fs from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "../abort.js";
import type { ResolvedOptions } from "../config.js";
import type { DepsPlan } from "./deps-plan.js";
import { runCommand } from "./process.js";

export type SetupDepsOptions = Pick<
  ResolvedOptions,
  "installCommand" | "installTimeoutMs" | "excerptChars"
>;

export type SetupDepsResult =
  | { ok: true }
  | { ok: false; reason: "dependency setup failed"; excerpt: string };

const fail = (excerpt: string): SetupDepsResult => ({
  ok: false,
  reason: "dependency setup failed",
  excerpt,
});

async function install(worktree: string, opts: SetupDepsOptions, signal?: AbortSignal): Promise<SetupDepsResult> {
  throwIfAborted(signal);
  if (!opts.installCommand) return fail("no installCommand set");
  const r = await runCommand(opts.installCommand, worktree, {
    timeoutMs: opts.installTimeoutMs,
    excerptChars: opts.excerptChars,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (r.spawnError !== undefined) return fail(`install failed to start: ${r.spawnError}`);
  if (r.timedOut) return fail(`install timed out\n${r.output}`);
  if (r.code !== 0) return fail(r.output);
  return { ok: true };
}

/** Give `worktree` its dependencies according to `plan`. Never touches the Repo's node_modules. */
export async function setupDeps(
  repo: string,
  worktree: string,
  plan: DepsPlan,
  opts: SetupDepsOptions,
  signal?: AbortSignal,
): Promise<SetupDepsResult> {
  throwIfAborted(signal);
  if (plan.method === "none") return { ok: true };
  if (plan.method === "install") return install(worktree, opts, signal);
  try {
    // Junctions need an absolute target and no admin rights on Windows.
    await fs.symlink(
      path.resolve(repo, "node_modules"),
      path.join(worktree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return { ok: true };
  } catch (e) {
    if (opts.installCommand) return install(worktree, opts, signal);
    return fail(`link failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Remove the dependency link (symlink / Windows junction) at `linkPath`, if present.
 * Never recursive: only the link itself is removed, never the Repo's real node_modules
 * it points at. Missing path is not an error. Throws if the link could not be removed.
 */
export async function removeLink(linkPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!stat.isSymbolicLink()) {
    // A real directory or file is not our link. Refuse to touch it.
    throw new Error(`refusing to remove ${linkPath}: not a symlink or junction`);
  }
  try {
    await fs.unlink(linkPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EISDIR") {
      // On Windows, rmdir removes a junction itself, not its target.
      await fs.rmdir(linkPath);
      return;
    }
    if (code === "ENOENT") return;
    throw e;
  }
}
