import { afterEach, describe, expect, it } from "vitest";
import { scanCommits } from "../src/history/scan.js";
import { git, makeRepo, type TestRepo } from "./helpers/repo.js";

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe("scanCommits", () => {
  it("returns newest first, drops the root commit, links parent", async () => {
    repo = makeRepo([
      { message: "root", files: { "a.txt": "1" } },
      { message: "second", files: { "a.txt": "2" } },
      { message: "third", files: { "a.txt": "3" } },
    ]);
    const out = await scanCommits(repo.dir, 500);
    expect(out.map((c) => c.message)).toEqual(["third", "second"]);
    expect(out[0]).toMatchObject({ sha: repo.shas[2], parent: repo.shas[1] });
    expect(out[1]).toMatchObject({ sha: repo.shas[1], parent: repo.shas[0] });
  });

  it("keeps multi-line messages intact, including blank lines", async () => {
    repo = makeRepo([
      { message: "root", files: { "a.txt": "1" } },
      { message: "fix: crash\n\nLong body line 1\nline 2\n\nFixes #12", files: { "a.txt": "2" } },
      { message: "next", files: { "a.txt": "3" } },
    ]);
    const out = await scanCommits(repo.dir, 500);
    expect(out).toHaveLength(2);
    expect(out[1]!.message).toBe("fix: crash\n\nLong body line 1\nline 2\n\nFixes #12");
    expect(out[0]!.message).toBe("next");
  });

  it("drops merge commits", async () => {
    repo = makeRepo([
      { message: "root", files: { "a.txt": "1" } },
      { message: "on main", files: { "a.txt": "2" } },
    ]);
    const dir = repo.dir;
    const main = git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(dir, "checkout", "-q", "-b", "side", repo.shas[0]!);
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "side work");
    git(dir, "checkout", "-q", main);
    git(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const out = await scanCommits(dir, 500);
    const messages = out.map((c) => c.message);
    expect(messages).not.toContain("merge side");
    expect(messages).toContain("side work");
    expect(messages).toContain("on main");
  });

  it("returns nothing for a single root commit", async () => {
    repo = makeRepo([{ message: "only", files: { "a.txt": "1" } }]);
    expect(await scanCommits(repo.dir, 500)).toEqual([]);
  });

  it("caps the scan at maxCommits", async () => {
    repo = makeRepo(
      Array.from({ length: 6 }, (_, i) => ({ message: `c${i}`, files: { "a.txt": String(i) } })),
    );
    const out = await scanCommits(repo.dir, 3);
    // The newest 3 commits are c5, c4, c3; all have parents.
    expect(out.map((c) => c.message)).toEqual(["c5", "c4", "c3"]);
  });

  it("anchors the scan to a captured base SHA instead of moving HEAD", async () => {
    repo = makeRepo([
      { message: "root", files: { "a.txt": "1" } },
      { message: "captured", files: { "a.txt": "2" } },
    ]);
    const captured = repo.shas[1]!;
    git(repo.dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "later");
    const out = await scanCommits(repo.dir, 500, captured);
    expect(out.map((c) => c.message)).toEqual(["captured"]);
  });
});
