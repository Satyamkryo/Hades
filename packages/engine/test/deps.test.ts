import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planDeps } from "../src/summon/deps-plan.js";
import { removeLink, setupDeps } from "../src/summon/deps.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hades-deps-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repoWithModules(): string {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "marker.txt"), "keep");
  return repo;
}

const node = JSON.stringify(process.execPath);
const base = { installTimeoutMs: 20_000, excerptChars: 1000 };

describe("planDeps", () => {
  it("alwaysInstall -> install even with node_modules", async () => {
    const p = await planDeps(repoWithModules(), { alwaysInstall: true, installCommand: "x" });
    expect(p).toEqual({ method: "install", workspace: false });
  });
  it("node_modules present -> link", async () => {
    const p = await planDeps(repoWithModules(), { alwaysInstall: false, installCommand: "x" });
    expect(p.method).toBe("link");
  });
  it("installCommand without node_modules -> install", async () => {
    const p = await planDeps(tmp(), { alwaysInstall: false, installCommand: "x" });
    expect(p.method).toBe("install");
  });
  it("nothing -> none", async () => {
    const p = await planDeps(tmp(), { alwaysInstall: false });
    expect(p).toEqual({ method: "none", workspace: false });
  });
});

describe("setupDeps", () => {
  it("links node_modules and removal keeps the Repo's files", async () => {
    const repo = repoWithModules();
    const wt = tmp();
    const r = await setupDeps(repo, wt, { method: "link", workspace: false }, base);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(wt, "node_modules", "marker.txt"), "utf8")).toBe("keep");
    await removeLink(path.join(wt, "node_modules"));
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "node_modules", "marker.txt"), "utf8")).toBe("keep");
  });

  it("falls back to install when linking fails", async () => {
    const repo = repoWithModules();
    const wt = tmp();
    fs.mkdirSync(path.join(wt, "node_modules")); // makes symlink fail with EEXIST
    const installCommand = `${node} -e "require('fs').writeFileSync('installed.txt','1')"`;
    const r = await setupDeps(repo, wt, { method: "link", workspace: false }, { ...base, installCommand });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(wt, "installed.txt"))).toBe(true);
  });

  it("link failure without installCommand is a dependency setup failure", async () => {
    const repo = repoWithModules();
    const wt = tmp();
    fs.mkdirSync(path.join(wt, "node_modules"));
    const r = await setupDeps(repo, wt, { method: "link", workspace: false }, base);
    expect(r).toMatchObject({ ok: false, reason: "dependency setup failed" });
  });

  it("install success", async () => {
    const wt = tmp();
    const installCommand = `${node} -e "require('fs').writeFileSync('installed.txt','1')"`;
    const r = await setupDeps(tmp(), wt, { method: "install", workspace: false }, { ...base, installCommand });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(wt, "installed.txt"))).toBe(true);
  });

  it("install failure returns reason and excerpt", async () => {
    const installCommand = `${node} -e "console.error('boom'); process.exit(3)"`;
    const r = await setupDeps(tmp(), tmp(), { method: "install", workspace: false }, { ...base, installCommand });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("dependency setup failed");
      expect(r.excerpt).toContain("boom");
    }
  });

  it("none does nothing", async () => {
    const wt = tmp();
    expect((await setupDeps(tmp(), wt, { method: "none", workspace: false }, base)).ok).toBe(true);
    expect(fs.readdirSync(wt)).toEqual([]);
  });
});
