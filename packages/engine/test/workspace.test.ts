import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkspaceRepo, planDeps, WORKSPACE_LINK_WARNING } from "../src/summon/deps-plan.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hades-workspace-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function withModules(repo: string): string {
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "marker.txt"), "keep");
  return repo;
}

/** A directory symlink (junction on Windows, which needs no admin rights). */
function linkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

const EXACT_WARNING =
  "workspace repo: linked node_modules may resolve sibling packages to the real working tree; results may be unreliable. Set installCommand.";

describe("isWorkspaceRepo", () => {
  it("workspaces array field in package.json", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    await expect(isWorkspaceRepo(repo)).resolves.toBe(true);
  });

  it("workspaces object field in package.json", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }));
    await expect(isWorkspaceRepo(repo)).resolves.toBe(true);
  });

  it("pnpm-workspace.yaml at the root", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await expect(isWorkspaceRepo(repo)).resolves.toBe(true);
  });

  it("top-level node_modules symlink resolving inside the repo", async () => {
    const repo = tmp();
    const target = path.join(repo, "packages", "foo");
    fs.mkdirSync(target, { recursive: true });
    withModules(repo);
    linkDir(target, path.join(repo, "node_modules", "foo"));
    await expect(isWorkspaceRepo(repo)).resolves.toBe(true);
  });

  it("@scope nested symlink resolving inside the repo", async () => {
    const repo = tmp();
    const target = path.join(repo, "packages", "foo");
    fs.mkdirSync(target, { recursive: true });
    withModules(repo);
    linkDir(target, path.join(repo, "node_modules", "@scope", "foo"));
    await expect(isWorkspaceRepo(repo)).resolves.toBe(true);
  });

  it("top-level symlink resolving outside the repo is not a workspace", async () => {
    const repo = tmp();
    withModules(repo);
    linkDir(tmp(), path.join(repo, "node_modules", "foo"));
    await expect(isWorkspaceRepo(repo)).resolves.toBe(false);
  });

  it("plain node_modules with no indicators is not a workspace", async () => {
    await expect(isWorkspaceRepo(withModules(tmp()))).resolves.toBe(false);
  });

  it("invalid package.json with no other indicators is not a workspace", async () => {
    const repo = withModules(tmp());
    fs.writeFileSync(path.join(repo, "package.json"), "{not json");
    await expect(isWorkspaceRepo(repo)).resolves.toBe(false);
  });

  it("missing node_modules with no indicators is not a workspace", async () => {
    await expect(isWorkspaceRepo(tmp())).resolves.toBe(false);
  });
});

describe("planDeps workspace rows", () => {
  it("workspace with installCommand -> install and never link", async () => {
    const repo = withModules(tmp());
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    const p = await planDeps(repo, { alwaysInstall: false, installCommand: "x" });
    expect(p).toEqual({ method: "install", workspace: true });
  });

  it("workspace without installCommand -> link with the exact warning text", async () => {
    const repo = withModules(tmp());
    fs.writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    const p = await planDeps(repo, { alwaysInstall: false });
    expect(p).toEqual({ method: "link", workspace: true, warning: EXACT_WARNING });
    expect(WORKSPACE_LINK_WARNING).toBe(EXACT_WARNING);
  });

  it("workspace with alwaysInstall -> install", async () => {
    const repo = withModules(tmp());
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    const p = await planDeps(repo, { alwaysInstall: true, installCommand: "x" });
    expect(p).toEqual({ method: "install", workspace: true });
  });

  it("workspace without node_modules or installCommand -> none", async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    const p = await planDeps(repo, { alwaysInstall: false });
    expect(p).toEqual({ method: "none", workspace: true });
  });
});
