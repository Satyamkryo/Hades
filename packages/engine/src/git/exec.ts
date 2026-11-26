import { execFile } from "node:child_process";
import { GitError } from "../errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunGitOptions {
  /** Return the result instead of throwing GitError on a non-zero exit. */
  allowFail?: boolean;
}

const REPOSITORY_ENV_OVERRIDES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

export function gitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of Object.keys(env)) {
    const matchedName = platform === "win32" ? name.toUpperCase() : name;
    if (
      REPOSITORY_ENV_OVERRIDES.has(matchedName) || matchedName === "HADES_LLM_API_KEY"
    ) {
      delete env[name];
    }
  }
  return env;
}

/**
 * Run git without a shell (arguments are an array, so paths are never parsed by a shell).
 * GIT_TERMINAL_PROMPT=0 stops credential prompts from blocking; LC_ALL=C gives stable
 * English output for parsing.
 */
export function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: gitEnvironment(),
      },
      (error, stdout, stderr) => {
        const command = `git ${args.join(" ")}`;
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const code = typeof error.code === "number" ? error.code : null;
        if (code === null) {
          // Spawn failure (git missing), buffer overflow, etc. Never "allowed".
          reject(new GitError(command, null, `${error.message}\n${stderr}`));
          return;
        }
        if (opts.allowFail) {
          resolve({ stdout, stderr, code });
          return;
        }
        reject(new GitError(command, code, stderr));
      },
    );
  });
}
