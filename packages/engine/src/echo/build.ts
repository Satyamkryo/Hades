import { createHash } from "node:crypto";
import type { HistoryCommit } from "../ask/types.js";
import type { Echo } from "../ask/types.js";
import type { HistoryCache } from "../cache/store.js";
import type { CommitContext } from "../github/context.js";
import type { GithubTarget } from "../github/remote.js";
import { closingIssueNumbers } from "../history/closing-issues.js";
import { createOpenAiCompatibleClient } from "../llm/client.js";
import { readLlmEnv } from "../llm/env.js";
import type { LlmClient } from "../llm/types.js";
import { ECHO_LLM_TIMEOUT_MS, ECHO_PROMPT_VERSION, llmEcho } from "./llm-echo.js";
import { RULE_ORDER_VERSION, ruleOrderEcho, type RuleEchoMeta } from "./rule-order.js";
import { collectSources, type Source } from "./sources.js";

/** At most this many LLM calls run at once; the cap keeps cost per Question small. */
export const ECHO_LLM_CONCURRENCY = 4;

export interface EchoBuildItem {
  commit: HistoryCommit;
  context: CommitContext | undefined;
}

export interface BuildEchoesDeps {
  /** Given: use it. Null: no LLM. Undefined: read `HADES_LLM_*` from `env`. */
  llm?: LlmClient | null;
  llmModel?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Small promise pool: at most `limit` tasks in flight, results by index, so
 * concurrency never changes the output order.
 */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = (await tasks[index]!()) as T;
    }
  });
  await Promise.all(workers);
  return results;
}

/** Cache key: everything the echo depends on, so any change recomputes it. */
export function echoInputKey(params: {
  sha: string;
  sources: Source[];
  diff: string;
  llm: string;
  meta: RuleEchoMeta;
}): string {
  const canonical = JSON.stringify({
    sha: params.sha,
    sources: params.sources.map((s) => ({
      id: s.id,
      kind: s.kind,
      ref: s.ref,
      url: s.url,
      text: s.text,
    })),
    diff: params.diff,
    llm: params.llm,
    meta: params.meta,
    prompt: ECHO_PROMPT_VERSION,
    rules: RULE_ORDER_VERSION,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function commitUrl(target: GithubTarget | undefined, sha: string): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  return `https://github.com/${target.owner}/${target.repo}/commit/${sha}`;
}

/**
 * Build one echo per commit (same order): cached echoes are reused, the
 * newest uncached commits get the LLM slots, the rest get the rule order.
 * Failed and over-cap echoes are not cached, so a later Question can retry
 * them; rule-order echoes without any LLM configured are cached.
 */
export async function buildEchoes(
  items: EchoBuildItem[],
  target: GithubTarget | undefined,
  cache: HistoryCache,
  deps: BuildEchoesDeps,
  opts: { maxLlmChecks: number },
): Promise<{ echoes: Echo[]; warnings: string[] }> {
  const warnings: string[] = [];

  let llm: LlmClient | null = null;
  let modelId = "none";
  if (deps.llm !== undefined) {
    if (deps.llm !== null) {
      llm = deps.llm;
      modelId = deps.llmModel ?? "injected";
    }
  } else {
    const env = deps.env ?? process.env;
    const blank = (name: string): boolean => (env[name]?.trim() ?? "") === "";
    if (
      !blank("HADES_LLM_BASE_URL") ||
      !blank("HADES_LLM_API_KEY") ||
      !blank("HADES_LLM_MODEL")
    ) {
      try {
        const cfg = readLlmEnv(env);
        llm = createOpenAiCompatibleClient(cfg, { timeoutMs: ECHO_LLM_TIMEOUT_MS });
        modelId = cfg.model;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const prepared = items.map((item) => {
    const sources = collectSources(item.commit, item.context, target);
    const pr = item.context?.pr;
    const meta: RuleEchoMeta = {
      prNumber: pr?.number,
      issueNumbers: closingIssueNumbers(`${item.commit.message}\n${pr?.body ?? ""}`),
      url: pr?.url ?? commitUrl(target, item.commit.sha),
    };
    const key = echoInputKey({
      sha: item.commit.sha,
      sources,
      diff: item.commit.diff,
      llm: modelId,
      meta,
    });
    return { item, sources, meta, key, cached: cache.getEcho(item.commit.sha, key) };
  });

  const slotIndices: number[] = [];
  let slotsUsed = 0;
  const echoes = new Array<Echo>(items.length);
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    if (p.cached !== undefined) {
      echoes[i] = p.cached;
    } else if (llm !== null && slotsUsed < opts.maxLlmChecks) {
      slotsUsed += 1;
      slotIndices.push(i);
    } else {
      const echo = ruleOrderEcho(p.item.commit.sha, p.sources, p.meta);
      if (llm === null) {
        cache.putEcho(p.item.commit.sha, p.key, echo);
      }
      echoes[i] = echo;
    }
  }

  const runner = llm;
  if (slotIndices.length > 0 && runner !== null) {
    const outcomes = await runWithConcurrency(
      slotIndices.map((i) => {
        const p = prepared[i]!;
        return () =>
          llmEcho(runner, {
            sha: p.item.commit.sha,
            sources: p.sources,
            diff: p.item.commit.diff,
            meta: p.meta,
          });
      }),
      ECHO_LLM_CONCURRENCY,
    );
    let failed = 0;
    let firstReason: string | undefined;
    slotIndices.forEach((itemIndex, slot) => {
      const outcome = outcomes[slot]!;
      const p = prepared[itemIndex]!;
      if (outcome.kind === "answered") {
        cache.putEcho(p.item.commit.sha, p.key, outcome.echo);
        echoes[itemIndex] = outcome.echo;
      } else {
        failed += 1;
        firstReason ??= outcome.reason;
        echoes[itemIndex] = outcome.echo;
      }
    });
    if (failed > 0) {
      warnings.push(
        `LLM unavailable for ${failed} commit${failed === 1 ? "" : "s"}: ${firstReason ?? "unknown error"}`,
      );
    }
  }
  return { echoes, warnings };
}
