import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedOptions } from "../config.js";

export const WORKSPACE_LINK_WARNING =
  "workspace repo: linked node_modules may resolve sibling packages to the real working tree; results may be unreliable. Set installCommand.";

export interface DepsPlan {
  method: "link" | "install" | "none";
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

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

/** True when `child` is strictly inside `root` (both realpath-normalised). */
function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Workspace-repo detection: the root package.json parses and has a `workspaces` field,
 * or `pnpm-workspace.yaml` exists at the root, or an entry in `<repo>/node_modules`
 * (top level, or one level inside `@scope/` folders) is a symlink whose realpath
 * resolves inside the Repo.
 */
export async function isWorkspaceRepo(repo: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "workspaces" in parsed) return true;
  } catch {
    // Missing or invalid package.json: fall through to the other rules.
  }

  if (await exists(path.join(repo, "pnpm-workspace.yaml"))) return true;

  let entries;
  try {
    entries = await fs.readdir(path.join(repo, "node_modules"), { withFileTypes: true });
  } catch {
    return false;
  }
  const repoReal = (await realpathOrUndefined(repo)) ?? repo;
  const resolvesInside = async (p: string): Promise<boolean> => {
    const real = await realpathOrUndefined(p);
    return real !== undefined && isInside(real, repoReal);
  };
  for (const entry of entries) {
    const entryPath = path.join(repo, "node_modules", entry.name);
    if (entry.isSymbolicLink()) {
      if (await resolvesInside(entryPath)) return true;
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      let scoped;
      try {
        scoped = await fs.readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (child.isSymbolicLink() && (await resolvesInside(path.join(entryPath, child.name)))) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Decide once per run how worktrees get dependencies. First matching row wins. */
export async function planDeps(repo: string, opts: DepsPlanOptions): Promise<DepsPlan> {
  const workspace = await isWorkspaceRepo(repo);
  if (opts.alwaysInstall) return { method: "install", workspace };
  if (workspace && opts.installCommand) return { method: "install", workspace };
  const hasModules = await exists(path.resolve(repo, "node_modules"));
  if (workspace && hasModules) {
    return { method: "link", workspace, warning: WORKSPACE_LINK_WARNING };
  }
  if (hasModules) return { method: "link", workspace };
  if (opts.installCommand) return { method: "install", workspace };
  return { method: "none", workspace };
}
