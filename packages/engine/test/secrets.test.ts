import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askHistory } from "../src/ask/ask-history.js";
import { repoId } from "../src/cache/repo-id.js";
import { gitEnvironment } from "../src/git/exec.js";
import type { LlmClient } from "../src/llm/types.js";
import { createFakeGithub } from "./helpers/fake-github.js";
import { git, makeRepo } from "./helpers/repo.js";

const TOKEN = "hadestoken-marker-1";
const API_KEY = "hadeskey-marker-2";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
  delete process.env["GITHUB_TOKEN"];
  delete process.env["HADES_LLM_API_KEY"];
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function dumpCache(home: string, repoDir: string): string {
  const dbPath = path.join(home, `${repoId(repoDir)}.db`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const out: Record<string, unknown> = {};
    for (const table of tables) {
      out[table.name] = db.prepare(`SELECT * FROM "${table.name}"`).all();
    }
    return JSON.stringify(out);
  } finally {
    db.close();
  }
}

describe("secrets", () => {
  it("keeps the token and API key out of answers, warnings, errors, cache and git env", async () => {
    process.env["GITHUB_TOKEN"] = TOKEN;
    process.env["HADES_LLM_API_KEY"] = API_KEY;

    const repo = makeRepo([
      { message: "create", files: { "calc.c": "int add(int a, int b) {\n  return a;\n}\n" } },
      { message: "tweak", files: { "calc.c": "int add(int a, int b) {\n  return a + 1;\n}\n" } },
    ]);
    const home = tempDir("hades-home-");
    try {
      git(repo.dir, "remote", "add", "origin", "https://github.com/octo/lib.git");
      const sha = repo.shas[0] ?? "";
      const fake = createFakeGithub(
        { pulls: {}, comments: {}, issues: {} },
        { pulls: { [sha]: { error: `boom ${TOKEN}` } } },
      );
      const throwingLlm: LlmClient = {
        complete: async () => {
          throw new Error(`nope ${API_KEY} down`);
        },
      };
      const answer = await askHistory(
        repo.dir,
        "calc.c",
        { lines: [1, 2], symbol: "add" },
        { github: fake.client, llm: throwingLlm, hadesHome: home },
      );

      expect(JSON.stringify(answer)).not.toContain(TOKEN);
      expect(JSON.stringify(answer)).not.toContain(API_KEY);
      for (const warning of answer.warnings) {
        expect(warning).not.toContain(TOKEN);
        expect(warning).not.toContain(API_KEY);
      }
      expect(dumpCache(home, repo.dir)).not.toContain(TOKEN);
      expect(dumpCache(home, repo.dir)).not.toContain(API_KEY);

      const childEnv = gitEnvironment();
      expect(Object.values(childEnv).join("\n")).not.toContain(TOKEN);
      expect(Object.values(childEnv).join("\n")).not.toContain(API_KEY);

      const thrown = await askHistory("Z:\\no\\such\\dir\\hades", "f.c").catch((e) => e);
      expect(String(thrown)).not.toContain(TOKEN);
      expect(String(thrown)).not.toContain(API_KEY);
    } finally {
      repo.cleanup();
    }
  });
});
