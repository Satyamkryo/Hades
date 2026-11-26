import { realpath } from "node:fs/promises";
import path from "node:path";
import { HadesConfigError, GitError } from "../errors.js";
import { runGit } from "../git/exec.js";

export interface ValidatedRepo {
  /** Absolute path of the repo root. */
  repo: string;
  /** HEAD commit, or undefined for an empty repo (no commits yet). */
  baseSha: string | undefined;
}

const MIN_GIT: [number, number] = [2, 30];

export function parseGitVersion(text: string): [number, number] | undefined {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export function isSupportedGit(v: [number, number]): boolean {
  return v[0] > MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] >= MIN_GIT[1]);
}

async function normalize(p: string): Promise<string> {
  const real = await realpath(p);
  const resolved = path.resolve(real);
  // Windows paths are case-insensitive; compare in one case.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function validateRepo(repoPath: string): Promise<ValidatedRepo> {
  if (!path.isAbsolute(repoPath)) {
    throw new HadesConfigError(`Repo path must be absolute: ${repoPath}`);
  }

  let versionText: string;
  try {
    versionText = (await runGit(process.cwd(), ["--version"])).stdout;
  } catch (e) {
    throw new HadesConfigError(`git is not available: ${(e as Error).message}`);
  }
  const version = parseGitVersion(versionText);
  if (!version || !isSupportedGit(version)) {
    throw new HadesConfigError(`git >= 2.30 is required, found: ${versionText.trim()}`);
  }

  let real: string;
  try {
    real = await realpath(repoPath);
  } catch {
    throw new HadesConfigError(`Repo path does not exist: ${repoPath}`);
  }

  const top = await runGit(real, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) {
    throw new HadesConfigError(`Not a git repository: ${repoPath}`);
  }
  // git prints forward slashes on Windows; realpath normalises both sides.
  const [a, b] = await Promise.all([normalize(top.stdout.trim()), normalize(real)]);
  if (a !== b) {
    throw new HadesConfigError(
      `Repo path must be the repository root (${top.stdout.trim()}), not a subfolder: ${repoPath}`,
    );
  }

  const head = await runGit(real, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowFail: true,
  });
  if (head.code === 0) {
    return { repo: real, baseSha: head.stdout.trim() };
  }
  // Exit 1 with --quiet means "no such commit": an empty repo.
  if (head.code === 1) {
    return { repo: real, baseSha: undefined };
  }
  throw new GitError("git rev-parse --verify HEAD", head.code, head.stderr);
}
