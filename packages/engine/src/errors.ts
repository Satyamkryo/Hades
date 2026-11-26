/** Bad options, bad repo, LLM config/auth problems. Raised before any worktree is made. */
export class HadesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HadesConfigError";
  }
}

/** The parent of a fix commit is missing (root commit, shallow clone). Callers map it to `lost`. */
export class ParentUnavailableError extends Error {
  static readonly REASON = "parent commit not available";
  readonly sha: string;

  constructor(sha: string) {
    super(ParentUnavailableError.REASON);
    this.name = "ParentUnavailableError";
    this.sha = sha;
  }
}

/** A git command failed. Usually turned into a `lost` reason by the caller. */
export class GitError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string) {
    const key = process.env["HADES_LLM_API_KEY"]?.trim();
    const safe = (text: string): string =>
      key ? text.split(key).join("***") : text;
    super(safe(`git command failed (${code ?? "no exit code"}): ${command}\n${stderr}`).trim());
    this.name = "GitError";
    this.command = safe(command);
    this.code = code;
    this.stderr = safe(stderr);
  }
}
