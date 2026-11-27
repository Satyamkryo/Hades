import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryCommit } from "../src/ask/types.js";
import { NullHistoryCache } from "../src/cache/null-store.js";
import { buildEchoes, ECHO_LLM_CONCURRENCY } from "../src/echo/build.js";
import { ECHO_LLM_TIMEOUT_MS } from "../src/echo/llm-echo.js";
import type { LlmClient } from "../src/llm/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function commit(index: number): HistoryCommit {
  return {
    sha: `${index}`.repeat(40),
    message: `commit number ${index} changes things`,
    author: "a",
    date: "2024-01-01T00:00:00+00:00",
    diff: `diff ${index}`,
    diffTruncated: false,
    foundBy: [],
  };
}

describe("echo concurrency", () => {
  it("runs at most 4 LLM calls at a time and keeps commit order", async () => {
    expect(ECHO_LLM_CONCURRENCY).toBe(4);
    vi.useFakeTimers();
    let inFlight = 0;
    let peak = 0;
    let done = 0;
    let call = 0;
    const completionOrder: number[] = [];
    const client: LlmClient = {
      complete: async () => {
        const index = call++;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, index === 3 ? 500 : 1000));
        inFlight -= 1;
        done += 1;
        completionOrder.push(index);
        return JSON.stringify({ explanation: "probably fake" });
      },
    };
    const items = [0, 1, 2, 3, 4].map((i) => ({ commit: commit(i), context: undefined }));
    const promise = buildEchoes(items, undefined, new NullHistoryCache(), { llm: client }, { maxLlmChecks: 5 });

    await vi.advanceTimersByTimeAsync(500);
    expect(completionOrder[0]).toBe(3);
    expect(done).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(peak).toBe(4);
    expect(done).toBe(4);
    expect(inFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(5);

    const { echoes } = await promise;
    expect(echoes.map((e) => e.sha)).toEqual(items.map((i) => i.commit.sha));
    expect(echoes.every((e) => e.confidence === "inferred")).toBe(true);
  });

  it("turns a hanging call into a timeout failure with a rule-order fallback", async () => {
    vi.useFakeTimers();
    const client: LlmClient = {
      complete: () => new Promise<string>(() => {}),
    };
    const promise = buildEchoes(
      [{ commit: commit(7), context: undefined }],
      undefined,
      new NullHistoryCache(),
      { llm: client },
      { maxLlmChecks: 5 },
    );
    await vi.advanceTimersByTimeAsync(ECHO_LLM_TIMEOUT_MS);
    const { echoes, warnings } = await promise;
    expect(echoes).toHaveLength(1);
    expect(echoes[0]?.confidence).toBe("said");
    expect(warnings).toEqual([
      `LLM unavailable for 1 commit: LLM request timed out after ${ECHO_LLM_TIMEOUT_MS} ms`,
    ]);
  });
});
