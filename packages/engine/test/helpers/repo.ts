import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTemp } from "../../src/summon/temp-registry.js";

/** Files to write in a commit. A `null` value deletes the file. */
export interface CommitSpec {
  message: string;
  files: Record<string, string | Buffer | null>;
}

export interface TestRepo {
  /** Absolute, realpath-normalised repo root. */
  dir: string;
  /** SHA of each commit, in the order of the spec. */
  shas: string[];
  cleanup(): void;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
}

/**
 * Build a temp git repo from a list of commits. autocrlf is off so file bytes stay exact.
 * `node_modules/marker.txt` is created and gitignored, so tests can check that cleanup never
 * deletes the repo's real node_modules.
 */
export function makeRepo(commits: CommitSpec[]): TestRepo {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hades-test-repo-")));
  registerTemp(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Hades Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");

  const shas: string[] = [];
  commits.forEach((spec, i) => {
    const files = { ...spec.files };
    if (i === 0 && files[".gitignore"] === undefined) {
      files[".gitignore"] = "node_modules/\n";
    }
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split("/"));
      if (content === null) {
        rmSync(abs, { force: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", spec.message);
    shas.push(git(dir, "rev-parse", "HEAD").trim());
  });

  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "marker.txt"), "marker");

  return {
    dir,
    shas,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
