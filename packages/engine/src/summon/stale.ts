import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { throwIfAborted } from "../abort.js";
import { HadesAbortError } from "../errors.js";
import { runGit } from "../git/exec.js";
import { currentProcessOwnerIdentity, parseHadesLockReason } from "./owner-identity.js";
import { REMOVE_WORKTREE_TIMEOUT_MS, removeWorktree } from "./worktree.js";

export interface WorktreeRecord {
  path: string;
  /** Lock reason after `locked `, or "" when `locked` has no reason, or undefined when unlocked. */
  locked?: string;
}

/** Parse `git worktree list --porcelain` into one record per worktree. */
export function parseWorktreeList(porcelain: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("locked")) {
      if (current !== undefined) {
        current.locked = line.length > "locked".length ? line.slice("locked ".length) : "";
      }
    } else if (line.trim() === "" && current !== undefined) {
      records.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

/** True when no process with this pid exists. EPERM means the process exists. */
export function isPidDead(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  try {
    kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/** True when `p` (or `p` itself if it no longer exists) is inside the OS temp dir. */
async function isInsideTmpdir(p: string, tmpdir: string): Promise<boolean> {
  const [realP, realTmp] = await Promise.all([realpathOrSelf(p), realpathOrSelf(tmpdir)]);
  const relative = path.relative(realTmp, realP);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function linkPathIfLink(worktreePath: string): Promise<string | undefined> {
  const candidate = path.join(worktreePath, "node_modules");
  try {
    return (await fs.lstat(candidate)).isSymbolicLink() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export interface CleanStaleOptions {
  /** Injected in tests; defaults to process.kill. */
  kill?: (pid: number, signal: 0) => void;
  /** Injected in tests; defaults to os.tmpdir(). */
  tmpdir?: string;
  /** Abort waiting for git/filesystem so SIGINT can reach recovery and exit 130. */
  signal?: AbortSignal;
  /** Overall bound for stale cleanup. Defaults to 30s. */
  timeoutMs?: number;
}

/** Overall bound so a hung git or filesystem wait cannot block cancellation forever. */
export const STALE_CLEANUP_TIMEOUT_MS = 30_000;

function abortErrorIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HadesAbortError();
}

async function withStaleBound<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  let onAbort: () => void = () => undefined;
  const abortPromise =
    signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new HadesAbortError());
            return;
          }
          onAbort = (): void => reject(new HadesAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
        });
  abortPromise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("stale cleanup timed out")), timeoutMs);
        })
      : new Promise<never>(() => undefined);
  timeoutPromise.catch(() => undefined);
  try {
    return await Promise.race([promise, abortPromise, timeoutPromise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Remove stale Hades worktrees at run start. A worktree is stale only when ALL hold:
 * 1. its folder basename starts with `hades-summon-`;
 * 2. its real path (or the path itself if gone) is inside the OS temp dir;
 * 3. it is locked with Hades owner metadata for this host and PID namespace;
 * 4. that owner's pid names a dead process (kill(pid, 0) throws ESRCH).
 * Unlocked worktrees, live-pid ones and non-Hades locks are never removed.
 * Returns the number removed. Individual removal failures are ignored so one bad
 * entry cannot fail the run.
 */
export async function cleanStaleWorktrees(repo: string, opts: CleanStaleOptions = {}): Promise<number> {
  const kill = opts.kill ?? process.kill;
  const tmpdir = opts.tmpdir ?? os.tmpdir();
  const signal = opts.signal;
  throwIfAborted(signal);
  const identity = await currentProcessOwnerIdentity();
  if (identity === undefined) return 0;
  const overallMs = opts.timeoutMs ?? STALE_CLEANUP_TIMEOUT_MS;
  const deadline = Date.now() + overallMs;
  const timeLeft = (): number => Math.max(0, deadline - Date.now());

  // The list itself is abortable and bounded: a hung git must not block SIGINT.
  // A timeout here is best-effort (return 0); an abort throws so the run settles.
  let porcelain: string;
  {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("stale cleanup timed out")), timeLeft());
    try {
      porcelain = (await runGit(repo, ["worktree", "list", "--porcelain"], { signal: controller.signal })).stdout;
    } catch (e) {
      abortErrorIfAborted(signal);
      return 0;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  let cleaned = 0;
  for (const record of parseWorktreeList(porcelain)) {
    // Cancellation stops new removals so the SIGINT path can reach recovery.
    throwIfAborted(signal);
    if (timeLeft() <= 0) break;
    if (!path.basename(record.path).startsWith("hades-summon-")) continue;
    if (record.locked === undefined) continue;
    const owner = parseHadesLockReason(record.locked);
    if (owner === undefined) continue;
    if (owner.identity.host !== identity.host || owner.identity.pidNamespace !== identity.pidNamespace) {
      continue;
    }
    try {
      const inside = await withStaleBound(isInsideTmpdir(record.path, tmpdir), signal, timeLeft());
      if (!inside) continue;
    } catch {
      abortErrorIfAborted(signal);
      continue;
    }
    if (!isPidDead(owner.pid, kill)) continue;
    try {
      // Bounded per entry; the in-flight removal runs to completion (or its own
      // timeout) so the link-first safety gate is never interrupted mid-way.
      // Individual failures and per-entry timeouts are ignored like before.
      const link = await withStaleBound(linkPathIfLink(record.path), signal, timeLeft());
      throwIfAborted(signal);
      const perEntryMs = Math.min(REMOVE_WORKTREE_TIMEOUT_MS, timeLeft());
      if (perEntryMs <= 0) break;
      await removeWorktree(repo, record.path, link, { timeoutMs: perEntryMs });
      cleaned += 1;
    } catch {
      // One bad entry must not fail the run, but an abort must still propagate
      // so cancellation cannot leave the run awaiting indefinitely.
      abortErrorIfAborted(signal);
    }
    // Re-check after each removal so an abort during removal still settles fast.
    throwIfAborted(signal);
  }
  return cleaned;
}
