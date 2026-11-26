import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git, makeRepo } from "./repo.js";
import { snapshot } from "./snapshot.js";

describe("test helpers", () => {
  it("builds commits, ignores node_modules and snapshots deterministically", () => {
    const repo = makeRepo([
      { message: "init", files: { "src/a.js": "1\n" } },
      { message: "fix: a", files: { "src/a.js": "2\n", "old.txt": "x" } },
      { message: "rm", files: { "old.txt": null } },
    ]);
    try {
      expect(repo.shas).toHaveLength(3);
      expect(git(repo.dir, "log", "--format=%s").trim().split("\n")).toEqual(["rm", "fix: a", "init"]);
      expect(git(repo.dir, "config", "core.autocrlf").trim()).toBe("false");
      expect(existsSync(path.join(repo.dir, "node_modules", "marker.txt"))).toBe(true);
      expect(git(repo.dir, "status", "--porcelain").trim()).toBe("");
      expect(snapshot(repo.dir)).toEqual(snapshot(repo.dir));
      expect(snapshot(repo.dir).files["node_modules/marker.txt"]).toBeDefined();
    } finally {
      repo.cleanup();
    }
  });

  it("records symlink targets without following them", () => {
    const repo = makeRepo([{ message: "init", files: { "target/file.txt": "x" } }]);
    try {
      const link = path.join(repo.dir, "linked");
      symlinkSync(
        path.join(repo.dir, "target"),
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      const before = snapshot(repo.dir);
      // Some Node versions include a trailing separator in Windows junction targets.
      expect(before.files["linked"]).toBe(`link:${readlinkSync(link)}`);
      mkdirSync(path.join(repo.dir, "target", "unseen"), { recursive: true });
      expect(snapshot(repo.dir).files["linked"]).toBe(before.files["linked"]);
    } finally {
      repo.cleanup();
    }
  });
});
