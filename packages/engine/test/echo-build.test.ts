import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryCommit } from "../src/ask/types.js";
import { openCache } from "../src/cache/store.js";
import {
  buildEchoes,
  echoInputKey,
  type EchoBuildItem,
} from "../src/echo/build.js";
import { ECHO_PROMPT_VERSION } from "../src/echo/llm-echo.js";
import { RULE_ORDER_VERSION } from "../src/echo/rule-order.js";
import { collectSources } from "../src/echo/sources.js";
import type { CommitContext } from "../src/github/context.js";
import type { LlmClient } from "../src/llm/types.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function commit(sha: string, message: string): HistoryCommit {
  return {
    sha,
    message,
    author: "a",
    date: "2024-01-01T00:00:00+00:00",
    diff: `diff ${sha.slice(0, 4)}`,
    diffTruncated: false,
    foundBy: [],
  };
}

function item(sha: string, message: string, context?: CommitContext): EchoBuildItem {
  return { commit: commit(sha, message), context };
}

function inferredLlm(): { calls: string[]; client: LlmClient } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      complete: async (_system: string, user: string) => {
        calls.push(user);
        const match = /id="commit"[^>]*>>>\n([\s\S]*?)\n<<<END/.exec(user);
        return JSON.stringify({ explanation: `probably explains ${(match?.[1] ?? "").slice(0, 20)}` });
      },
    },
  };
}

describe("buildEchoes", () => {
  it("reuses cached echoes and recomputes on input change", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const sha = "a".repeat(40);
      const fake = inferredLlm();
      const run = (message: string, llmModel?: string) =>
        buildEchoes([item(sha, message)], undefined, cache, { llm: fake.client, llmModel }, { maxLlmChecks: 5 });

      const first = await run("alpha message here");
      expect(fake.calls).toHaveLength(1);
      expect(first.echoes[0]?.confidence).toBe("inferred");

      const second = await run("alpha message here");
      expect(fake.calls).toHaveLength(1);
      expect(second.echoes).toEqual(first.echoes);

      await run("alpha message changed");
      expect(fake.calls).toHaveLength(2);

      await run("alpha message changed", "other-model");
      expect(fake.calls).toHaveLength(3);
    } finally {
      cache.close();
    }
  });

  it("keys echoes by sources, diff, model and prompt versions", () => {
    const sha = "b".repeat(40);
    const sources = [{ id: "commit", kind: "commit-message", ref: sha, url: "https://example.test/commit", text: "hello world" }] as const;
    const meta = { prNumber: 12, issueNumbers: [3, 4], url: "https://example.test/pr/12" };
    const base = { sha, sources: [...sources], diff: "d", llm: "m", meta };
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          sha,
          sources: [{ id: "commit", kind: "commit-message", ref: sha, url: "https://example.test/commit", text: "hello world" }],
          diff: "d",
          llm: "m",
          meta,
          prompt: ECHO_PROMPT_VERSION,
          rules: RULE_ORDER_VERSION,
        }),
      )
      .digest("hex");
    expect(echoInputKey(base)).toBe(expected);
    expect(echoInputKey({ ...base })).toBe(expected);
    expect(echoInputKey({ ...base, diff: "other" })).not.toBe(expected);
    expect(echoInputKey({ ...base, llm: "other" })).not.toBe(expected);
    expect(echoInputKey({ ...base, sources: [{ ...sources[0], ref: "other-ref" }] })).not.toBe(expected);
    expect(echoInputKey({ ...base, sources: [{ ...sources[0], url: "https://example.test/other" }] })).not.toBe(expected);
    expect(echoInputKey({ ...base, meta: { ...meta, prNumber: 13 } })).not.toBe(expected);
    expect(echoInputKey({ ...base, meta: { ...meta, issueNumbers: [5] } })).not.toBe(expected);
    expect(echoInputKey({ ...base, meta: { ...meta, url: "https://example.test/other" } })).not.toBe(expected);
    expect(
      echoInputKey({
        ...base,
        sources: [{ id: "commit", kind: "commit-message", ref: sha, text: "changed" }],
      }),
    ).not.toBe(expected);
  });

  it("gives the cap to the newest commits and upgrades the rest on warm runs", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const shas = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];
      const items = [item(shas[0]!, "newest commit here"), item(shas[1]!, "middle commit here"), item(shas[2]!, "oldest commit here")];
      const fake = inferredLlm();

      const cold = await buildEchoes(items, undefined, cache, { llm: fake.client }, { maxLlmChecks: 1 });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toContain("newest commit here");
      expect(cold.echoes.map((e) => e.confidence)).toEqual(["inferred", "said", "said"]);

      const warm = await buildEchoes(items, undefined, cache, { llm: fake.client }, { maxLlmChecks: 1 });
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[1]).toContain("middle commit here");
      expect(warm.echoes.map((e) => e.confidence)).toEqual(["inferred", "inferred", "said"]);

      const warmer = await buildEchoes(items, undefined, cache, { llm: fake.client }, { maxLlmChecks: 1 });
      expect(fake.calls).toHaveLength(3);
      expect(warmer.echoes.map((e) => e.confidence)).toEqual(["inferred", "inferred", "inferred"]);
      expect(warmer.warnings).toEqual([]);
    } finally {
      cache.close();
    }
  });

  it("does not cache failed or over-cap echoes", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      let calls = 0;
      const failing: LlmClient = {
        complete: async () => {
          calls += 1;
          throw new Error("LLM endpoint returned 401");
        },
      };
      const sha = "c".repeat(40);
      const first = await buildEchoes([item(sha, "some commit here")], undefined, cache, { llm: failing }, { maxLlmChecks: 5 });
      expect(calls).toBe(1);
      expect(first.echoes[0]?.confidence).toBe("said");
      expect(first.warnings).toEqual(["LLM unavailable for 1 commit: LLM endpoint returned 401"]);

      const second = await buildEchoes([item(sha, "some commit here")], undefined, cache, { llm: failing }, { maxLlmChecks: 5 });
      expect(calls).toBe(2);
      expect(second.echoes).toEqual(first.echoes);
      expect(second.warnings).toEqual(first.warnings);
    } finally {
      cache.close();
    }
  });

  it("assembles echoes in commit order when calls finish in reverse", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const shas = ["4".repeat(40), "5".repeat(40), "6".repeat(40)];
      const delays = [30, 20, 10];
      const client: LlmClient = {
        complete: async (_system: string, user: string) => {
          const index = shas.findIndex((sha) => user.includes(sha.slice(0, 4)));
          await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
          return JSON.stringify({ explanation: "probably async" });
        },
      };
      const items = shas.map((sha, i) => item(sha, `commit number ${i} here`));
      const { echoes } = await buildEchoes(items, undefined, cache, { llm: client }, { maxLlmChecks: 5 });
      expect(echoes.map((e) => e.sha)).toEqual(shas);
      expect(echoes.every((e) => e.confidence === "inferred")).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("caches rule-order echoes when no LLM is configured", async () => {
    const home = tempDir("hades-home-");
    const repo = tempDir("hades-repo-");
    const { cache } = openCache(repo, { hadesHome: home });
    try {
      const sha = "d".repeat(40);
      const first = await buildEchoes([item(sha, "a plain commit here")], undefined, cache, { llm: null }, { maxLlmChecks: 5 });
      expect(first.warnings).toEqual([]);
      expect(first.echoes[0]?.confidence).toBe("said");
      const key = echoInputKey({
        sha,
        sources: collectSources(commit(sha, "a plain commit here"), undefined, undefined),
        diff: `diff ${sha.slice(0, 4)}`,
        llm: "none",
        meta: { issueNumbers: [] },
      });
      expect(cache.getEcho(sha, key)?.text).toBe(first.echoes[0]?.text);
    } finally {
      cache.close();
    }
  });

  it("reads the LLM from the environment, warning on partial settings", async () => {
    const home = tempDir("hades-home-");
    const { cache } = openCache(tempDir("hades-repo-"), { hadesHome: home });
    try {
      const sha = "e".repeat(40);
      const empty = await buildEchoes([item(sha, "a plain commit here")], undefined, cache, { env: {} }, { maxLlmChecks: 5 });
      expect(empty.warnings).toEqual([]);
      expect(empty.echoes[0]?.confidence).toBe("said");

      const partial = await buildEchoes(
        [item(sha, "a plain commit here")],
        undefined,
        cache,
        { env: { HADES_LLM_BASE_URL: "http://localhost:9" } },
        { maxLlmChecks: 5 },
      );
      expect(partial.echoes[0]?.confidence).toBe("said");
      expect(partial.warnings).toEqual([
        "Missing LLM environment variable(s): HADES_LLM_API_KEY, HADES_LLM_MODEL",
      ]);
    } finally {
      cache.close();
    }
  });
});
