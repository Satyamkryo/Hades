import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseGithubRemote, readGithubTarget } from "../src/github/remote.js";
import { git, makeRepo } from "./helpers/repo.js";

describe("parseGithubRemote", () => {
  it("parses https remotes and ignores credentials", () => {
    expect(parseGithubRemote("https://github.com/octo/lib.git")).toEqual({
      owner: "octo",
      repo: "lib",
    });
    expect(
      parseGithubRemote("https://user:pass@github.com/octo/lib/"),
    ).toEqual({ owner: "octo", repo: "lib" });
    expect(parseGithubRemote("https://user@github.com/octo/lib")).toEqual({
      owner: "octo",
      repo: "lib",
    });
  });

  it("parses ssh and scp remotes", () => {
    expect(parseGithubRemote("ssh://git@github.com/octo/lib.git")).toEqual({
      owner: "octo",
      repo: "lib",
    });
    expect(parseGithubRemote("ssh://git@github.com:22/octo/lib")).toEqual({
      owner: "octo",
      repo: "lib",
    });
    expect(parseGithubRemote("git@github.com:octo/lib.git")).toEqual({
      owner: "octo",
      repo: "lib",
    });
    expect(parseGithubRemote("git@github.com:octo/lib")).toEqual({
      owner: "octo",
      repo: "lib",
    });
  });

  it("matches github.com case-insensitively and rejects anything else", () => {
    expect(parseGithubRemote("https://GitHub.COM/octo/lib")).toEqual({
      owner: "octo",
      repo: "lib",
    });
    expect(parseGithubRemote("https://gitlab.com/octo/lib")).toBeUndefined();
    expect(parseGithubRemote("https://ghe.example.com/octo/lib")).toBeUndefined();
    expect(parseGithubRemote("git@ghe.example.com:octo/lib.git")).toBeUndefined();
    expect(parseGithubRemote("http://github.com/octo/lib")).toBeUndefined();
  });

  it("rejects garbage", () => {
    expect(parseGithubRemote("")).toBeUndefined();
    expect(parseGithubRemote("not a url")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/octo")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/octo/lib/extra")).toBeUndefined();
    expect(parseGithubRemote("https://github.com//lib")).toBeUndefined();
    expect(parseGithubRemote("C:\\repos\\lib")).toBeUndefined();
    expect(parseGithubRemote("/abs/path")).toBeUndefined();
  });

  it("never leaks credentials and only accepts github.com", () => {
    fc.assert(
      fc.property(
        fc.record({
          user: fc
            .stringOf(fc.constantFrom("A", "B", "9", "x"), { minLength: 2, maxLength: 8 })
            .filter((s) => /[A-Z0-9]/.test(s)),
          pass: fc
            .stringOf(fc.constantFrom("Q", "7", "z"), { minLength: 2, maxLength: 8 })
            .filter((s) => /[A-Z0-9]/.test(s)),
          host: fc.constantFrom(
            "github.com",
            "GitHub.COM",
            "GITHUB.com",
            "gitlab.com",
            "ghe.example.com",
          ),
        }),
        ({ user, pass, host }) => {
          const url = `https://${user}:${pass}@${host}/octo/lib.git`;
          const target = parseGithubRemote(url);
          // Owner and repo are lowercase alpha, so a credential holding an
          // uppercase letter or digit can only appear via a leak.
          const blob = JSON.stringify(target) ?? "undefined";
          expect(blob).not.toContain(user);
          expect(blob).not.toContain(pass);
          if (host.toLowerCase() === "github.com") {
            expect(target).toEqual({ owner: "octo", repo: "lib" });
          } else {
            expect(target).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("readGithubTarget", () => {
  it("returns undefined without an origin", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      expect(await readGithubTarget(repo.dir)).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });

  it("parses a GitHub origin and ignores other hosts", async () => {
    const repo = makeRepo([{ message: "init", files: { "a.txt": "a" } }]);
    try {
      git(repo.dir, "remote", "add", "origin", "git@github.com:octo/lib.git");
      expect(await readGithubTarget(repo.dir)).toEqual({ owner: "octo", repo: "lib" });
      git(repo.dir, "remote", "set-url", "origin", "https://gitlab.com/octo/lib.git");
      expect(await readGithubTarget(repo.dir)).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});
