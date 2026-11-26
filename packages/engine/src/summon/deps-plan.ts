import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedOptions } from "../config.js";

export interface DepsPlan {
  method: "link" | "install" | "none";
  /** Always false until optional workspace detection (task 15.3) exists. */
  workspace: boolean;
  warning?: string;
}

export type DepsPlanOptions = Pick<ResolvedOptions, "alwaysInstall" | "installCommand">;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Decide once per run how worktrees get dependencies. First matching row wins. */
export async function planDeps(repo: string, opts: DepsPlanOptions): Promise<DepsPlan> {
  if (opts.alwaysInstall) return { method: "install", workspace: false };
  if (await exists(path.resolve(repo, "node_modules"))) return { method: "link", workspace: false };
  if (opts.installCommand) return { method: "install", workspace: false };
  return { method: "none", workspace: false };
}
