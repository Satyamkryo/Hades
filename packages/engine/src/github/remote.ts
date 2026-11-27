import { runGit } from "../git/exec.js";

export interface GithubTarget {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Split "owner/repo[.git][/]" into a target; anything else is not GitHub. */
function splitPath(pathname: string): GithubTarget | undefined {
  const withoutGit = pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  const [owner, repo, ...rest] = withoutGit.split("/").filter((part) => part !== "");
  if (owner === undefined || repo === undefined || rest.length > 0) {
    return undefined;
  }
  if (!NAME.test(owner) || !NAME.test(repo)) {
    return undefined;
  }
  return { owner, repo };
}

/**
 * Parse a git remote URL. Accepts https (credentials ignored), ssh and the
 * scp-like `git@github.com:owner/repo` form; only `github.com` (any case).
 * Anything else is local-only mode: `undefined`, never a warning.
 */
export function parseGithubRemote(url: string): GithubTarget | undefined {
  const trimmed = url.trim();
  if (trimmed === "") {
    return undefined;
  }
  // scp-like syntax does not parse as a URL: user@host:path. It never has a scheme.
  if (!trimmed.includes("://")) {
    const scp = /^(?:[^@:/\s]+@)?([^:/\s]+):(.*)$/.exec(trimmed);
    if (scp !== null) {
      const host = scp[1] ?? "";
      const pathname = scp[2] ?? "";
      if (host.toLowerCase() !== "github.com") {
        return undefined;
      }
      return splitPath(pathname);
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  return splitPath(parsed.pathname);
}

/**
 * Read the `origin` remote of a repo. A missing origin (non-zero exit) means
 * local-only mode: `undefined`. The raw URL is never exposed to callers.
 */
export async function readGithubTarget(repo: string): Promise<GithubTarget | undefined> {
  const result = await runGit(repo, ["remote", "get-url", "origin"], { allowFail: true });
  if (result.code !== 0) {
    return undefined;
  }
  return parseGithubRemote(result.stdout.trim());
}
