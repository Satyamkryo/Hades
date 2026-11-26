import { lstat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../src/git/exec.js";
import { trackedWorktrees } from "../src/summon/worktree.js";

export interface RecoveryOptions {
  repo: string;
  pid: number;
  platform?: NodeJS.Platform;
}

function posixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function winShellArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Parse `git worktree list --porcelain` and return the paths of worktrees whose lock reason
 * is exactly `hades pid=<pid>`. Records are separated by blank lines; a locked record has a
 * `locked <reason>` line.
 */
export function parseLockedWorktrees(porcelain: string, pid: number): string[] {
  const wanted = `hades pid=${pid}`;
  const found: string[] = [];
  for (const record of porcelain.split(/\r?\n\r?\n/)) {
    let worktree: string | undefined;
    let reason: string | undefined;
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
      else if (line.startsWith("locked ")) reason = line.slice("locked ".length);
    }
    if (worktree !== undefined && reason === wanted) found.push(worktree);
  }
  return found;
}

/**
 * Build the manual recovery commands for one worktree, in the order they must be run:
 * link removal first (so `worktree remove --force` can never follow the link into the
 * Repo's real node_modules), then unlock, then remove. Nothing is executed.
 */
export function buildRecoveryCommands(
  repo: string,
  worktree: string,
  linked: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const win = platform === "win32";
  const wt = win ? path.win32.normalize(worktree) : worktree;
  const commands: string[] = [];
  if (linked) {
    // No /s and no -r: removes only the link, never the folder it points at.
    commands.push(
      win
        ? `cmd /c rmdir ${winShellArg(path.win32.join(wt, "node_modules"))}`
        : `rm -- ${posixShellArg(path.posix.join(wt, "node_modules"))}`,
    );
  }
  if (win) {
    commands.push(`git -C ${winShellArg(repo)} worktree unlock ${winShellArg(wt)}`);
    commands.push(`git -C ${winShellArg(repo)} worktree remove --force ${winShellArg(wt)}`);
  } else {
    commands.push(`git -C ${posixShellArg(repo)} worktree unlock ${posixShellArg(wt)}`);
    commands.push(`git -C ${posixShellArg(repo)} worktree remove --force ${posixShellArg(wt)}`);
  }
  return commands;
}

async function isLink(p: string): Promise<boolean> {
  try {
    // lstat does not follow links; Node reports Windows junctions as symbolic links.
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Lines to print on Ctrl+C. Reads git and the filesystem, changes nothing.
 * Returns an empty list when this process holds no locked worktree.
 */
export async function recoveryLines(opts: RecoveryOptions): Promise<string[]> {
  const { repo, pid, platform = process.platform } = opts;
  const res = await runGit(repo, ["worktree", "list", "--porcelain"], { allowFail: true });
  const lines: string[] = [];
  const registered = new Set(res.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).map((line) => path.resolve(line.slice(9))));
  const tracked = pid === process.pid ? trackedWorktrees(repo) : [];
  const remaining = await Promise.all(tracked.map(async (wt) => {
    try {
      await lstat(wt);
      return wt;
    } catch {
      return registered.has(path.resolve(wt)) ? wt : undefined;
    }
  }));
  const worktrees = new Set([...parseLockedWorktrees(res.stdout, pid), ...remaining.filter((wt): wt is string => wt !== undefined)].map((wt) => path.resolve(wt)));
  for (const worktree of worktrees) {
    const linked = await isLink(path.join(worktree, "node_modules"));
    lines.push(`Interrupted. To clean up the worktree ${worktree}, run in this order:`);
    for (const c of buildRecoveryCommands(repo, worktree, linked, platform)) lines.push(`  ${c}`);
  }
  return lines;
}
