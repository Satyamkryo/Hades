import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envWithoutLlmKey, runCommand, terminateRunningCommands } from "../src/summon/process.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-proc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = { timeoutMs: 20_000, excerptChars: 4000 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(file: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (/^\d+$/.test(readFileSync(file, "utf8"))) return;
    } catch { /* The descendant has not written the file yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`descendant did not become ready: ${file}`);
}

describe("runCommand", () => {
  it("removes case variants only on Windows", () => {
    const win = envWithoutLlmKey({
      HADES_LLM_API_KEY: "exact",
      hades_llm_api_key: "lower",
    }, "win32");
    expect(Object.keys(win).filter((name) => name.toUpperCase() === "HADES_LLM_API_KEY")).toEqual([]);
    expect(envWithoutLlmKey({
      HADES_LLM_API_KEY: "exact",
      hades_llm_api_key: "lower",
    }, "linux")).toMatchObject({ hades_llm_api_key: "lower" });
  });

  it("removes repository overrides without changing unrelated environment variables", () => {
    const source = { git_dir: "other", GIT_DIR: "repo", GIT_WORK_TREE: "tree", KEEP_ME: "yes" };
    const windows = envWithoutLlmKey(source, "win32");
    expect(windows.git_dir).toBeUndefined();
    expect(windows.GIT_DIR).toBeUndefined();
    expect(windows.GIT_WORK_TREE).toBeUndefined();
    expect(windows.KEEP_ME).toBe("yes");
    const unix = envWithoutLlmKey(source, "linux");
    expect(unix.git_dir).toBe("other");
    expect(unix.GIT_DIR).toBeUndefined();
    expect(unix.GIT_WORK_TREE).toBeUndefined();
    expect(source.GIT_DIR).toBe("repo");
  });

  it("reports exit code 0 and output", async () => {
    const r = await runCommand(`node -e "console.log('hi')"`, dir, opts);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("hi");
  });

  it("reports a non-zero exit code", async () => {
    const r = await runCommand(`node -e "process.exit(3)"`, dir, opts);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("reports a spawn error for a missing cwd", async () => {
    const r = await runCommand("node -v", join(dir, "missing"), opts);
    expect(r.spawnError).toBeTruthy();
    expect(r.code).toBeNull();
  });

  it("kills a child-spawning process tree on timeout", async () => {
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(
      join(dir, "grandchild.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      join(dir, "parent.mjs"),
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.mjs"))}], { stdio: "ignore" });
setInterval(() => {}, 1000);`,
    );
    const r = await runCommand("node parent.mjs", dir, { timeoutMs: 2500, excerptChars: 100 });
    expect(r.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Give the OS a moment to reap the killed process.
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("terminates an active child-spawning process tree on demand", async () => {
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(
      join(dir, "grandchild.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      join(dir, "parent.mjs"),
      `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.mjs"))}], { stdio: "ignore" });
setInterval(() => {}, 1000);`,
    );
    const pending = runCommand("node parent.mjs", dir, opts);
    try {
      await waitForPidFile(pidFile);
    } finally {
      await terminateRunningCommands();
    }
    const r = await pending;
    expect(r.spawnError).toBeUndefined();
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("cleans up descendants when the shell closes with an exit code", async () => {
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(
      join(dir, "grandchild.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      join(dir, "parent.mjs"),
      `import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.mjs"))}], { stdio: "ignore" });
const deadline = Date.now() + 5000;
let ready = false;
while (Date.now() < deadline) {
  try { ready = /^\\d+$/.test(readFileSync(${JSON.stringify(pidFile)}, "utf8")); } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!ready) process.exit(9);
process.exit(7);`,
    );
    const r = await runCommand("node parent.mjs", dir, opts);
    expect(r.code).toBe(7);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("cleans up a worker holding inherited output after the shell exits", async () => {
    const pidFile = join(dir, "worker.pid");
    writeFileSync(join(dir, "worker.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log("worker started");
setInterval(() => {}, 1000);`);
    writeFileSync(join(dir, "parent.mjs"), `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const worker = spawn(process.execPath, [${JSON.stringify(join(dir, "worker.mjs"))}], { stdio: "inherit" });
worker.unref();
while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((resolve) => setTimeout(resolve, 20));
console.log("parent exiting");
process.exit(7);`);
    try {
      const result = await runCommand("node parent.mjs", dir, { timeoutMs: 2000, excerptChars: 4000 });
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(7);
      expect(result.output).toContain("worker started");
      expect(result.output).toContain("parent exiting");
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    } finally {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch { /* already stopped */ }
      }
    }
  }, 15_000);

  it("keeps only the last excerptChars characters", async () => {
    const r = await runCommand(
      `node -e "process.stdout.write('a'.repeat(50000)+'END')"`,
      dir,
      { timeoutMs: 20_000, excerptChars: 100 },
    );
    expect(r.output.length).toBeLessThanOrEqual(100);
    expect(r.output.endsWith("END")).toBe(true);
  });

  it("hides HADES_LLM_API_KEY and sets CI=true", async () => {
    const prev = process.env.HADES_LLM_API_KEY;
    process.env.HADES_LLM_API_KEY = "secret-key-123";
    try {
      const r = await runCommand(
        `node -e "console.log('key=' + String(process.env.HADES_LLM_API_KEY) + ' ci=' + process.env.CI)"`,
        dir,
        opts,
      );
      expect(r.output).toContain("key=undefined");
      expect(r.output).toContain("ci=true");
      expect(r.output).not.toContain("secret-key-123");
    } finally {
      if (prev === undefined) delete process.env.HADES_LLM_API_KEY;
      else process.env.HADES_LLM_API_KEY = prev;
    }
  });

  it("does not pass inherited Git repository overrides to commands", async () => {
    const previousDir = process.env.GIT_DIR;
    const previousTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = "other-repo";
    process.env.GIT_WORK_TREE = "other-tree";
    try {
      const result = await runCommand(
        `node -e "console.log(String(process.env.GIT_DIR), String(process.env.GIT_WORK_TREE))"`,
        dir,
        opts,
      );
      expect(result.code).toBe(0);
      expect(result.output.trim()).toBe("undefined undefined");
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousDir;
      if (previousTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousTree;
    }
  });
});
