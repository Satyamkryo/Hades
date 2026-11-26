import { describe, expect, it } from "vitest";
import { GitError } from "../src/errors.js";
import { gitEnvironment, runGit } from "../src/git/exec.js";
import { makeRepo } from "./helpers/repo.js";

describe("runGit", () => {
  it("removes Git repository overrides using platform-specific case rules", () => {
    const source = { git_dir: "other", GIT_WORK_TREE: "other", KEEP_ME: "yes" };
    const windows = gitEnvironment(source, "win32");
    expect(windows.git_dir).toBeUndefined();
    expect(windows.GIT_WORK_TREE).toBeUndefined();
    expect(windows.KEEP_ME).toBe("yes");
    const unix = gitEnvironment(source, "linux");
    expect(unix.git_dir).toBe("other");
    expect(unix.GIT_WORK_TREE).toBeUndefined();
    expect(source.git_dir).toBe("other");
  });

  it("removes the LLM key while preserving unrelated Git environment", () => {
    const env = gitEnvironment({
      HADES_LLM_API_KEY: "secret",
      hades_llm_api_key: "variant",
      KEEP_ME: "yes",
    });
    expect(env.KEEP_ME).toBe("yes");
    expect(env.HADES_LLM_API_KEY).toBeUndefined();
    if (process.platform === "win32") {
      expect(Object.keys(env).filter((name) => name.toUpperCase() === "HADES_LLM_API_KEY")).toEqual([]);
    } else {
      expect(env.hades_llm_api_key).toBe("variant");
    }
  });

  it("redacts the API key from GitError details", () => {
    const previous = process.env.HADES_LLM_API_KEY;
    process.env.HADES_LLM_API_KEY = "secret-key-123";
    try {
      const err = new GitError("git worktree add", 1, "hook saw secret-key-123");
      expect(err.message).not.toContain("secret-key-123");
      expect(err.stderr).not.toContain("secret-key-123");
      expect(err.stderr).toContain("***");
    } finally {
      if (previous === undefined) delete process.env.HADES_LLM_API_KEY;
      else process.env.HADES_LLM_API_KEY = previous;
    }
  });
  it("returns stdout", async () => {
    const r = await runGit(process.cwd(), ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
  });

  it("throws GitError on non-zero exit", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      await expect(runGit(repo.dir, ["cat-file", "-e", "deadbeef"])).rejects.toBeInstanceOf(GitError);
    } finally {
      repo.cleanup();
    }
  });

  it("GitError carries exit code and command", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      const err = await runGit(repo.dir, ["cat-file", "-e", "deadbeef"]).catch((e) => e);
      expect(err).toBeInstanceOf(GitError);
      expect(err.code).not.toBe(0);
      expect(err.command).toContain("cat-file");
    } finally {
      repo.cleanup();
    }
  });

  it("throws GitError (even with allowFail) when cwd does not exist", async () => {
    await expect(
      runGit("Z:\\no\\such\\dir\\hades", ["--version"], { allowFail: true }),
    ).rejects.toBeInstanceOf(GitError);
  });

  it("returns the result with allowFail", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      const r = await runGit(repo.dir, ["cat-file", "-e", "deadbeef"], { allowFail: true });
      expect(r.code).not.toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});
