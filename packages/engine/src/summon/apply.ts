import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../git/exec.js";
import type { LostReason } from "../report/types.js";
import { registerTemp } from "./temp-registry.js";

export type ApplyResult =
  | { ok: true }
  | { ok: false; reason: Extract<LostReason, "revert did not apply">; excerpt: string };

const DEFAULT_EXCERPT_CHARS = 4000;

/**
 * Reverse-apply a fix patch (parent -> fix) inside a worktree.
 *
 * `-R` undoes the fix. `--3way` falls back to a three-way merge using the blob IDs in the
 * patch when later commits changed the surrounding lines. With conflicts git exits non-zero
 * and leaves unmerged paths, so success needs exit 0 AND no unmerged paths
 * (`--diff-filter=U`). The patch file lives in its own temp dir outside the worktree.
 */
export async function reverseApply(
  worktree: string,
  patch: string,
  excerptChars = DEFAULT_EXCERPT_CHARS,
): Promise<ApplyResult> {
  const patchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hades-patch-"));
  registerTemp(patchDir);
  try {
    const patchFile = path.join(patchDir, "fix.patch");
    await fs.writeFile(patchFile, patch);
    const res = await runGit(
      worktree,
      ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile],
      { allowFail: true },
    );
    if (res.code !== 0) {
      return fail(res.stderr, excerptChars);
    }
    const unmerged = await runGit(worktree, ["diff", "--name-only", "--diff-filter=U"], {
      allowFail: true,
    });
    if (unmerged.code !== 0 || unmerged.stdout.trim() !== "") {
      const detail = unmerged.stdout.trim()
        ? `unmerged paths:\n${unmerged.stdout.trim()}\n${res.stderr}`
        : unmerged.stderr || res.stderr;
      return fail(detail, excerptChars);
    }
    return { ok: true };
  } finally {
    await fs.rm(patchDir, { recursive: true, force: true });
  }
}

function fail(stderr: string, max: number): ApplyResult {
  const text = stderr.trim();
  return {
    ok: false,
    reason: "revert did not apply",
    excerpt: text.length > max ? text.slice(-max) : text,
  };
}
