import { describe, expect, it } from "vitest";
import { HadesConfigError } from "../src/errors.js";
import { LlmHttpError, LlmNetworkError } from "../src/llm/client.js";
import { confirmCandidates, type Candidate } from "../src/llm/confirm-loop.js";
import { answer, createFakeLlm } from "./helpers/fake-llm.js";

/** Newest first, like the scan output. */
const candidates = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`,
    parent: `parent${i}`,
    message: `fix ${i}`,
    matchedRules: ["keyword"],
  }));

const summarize = async (sha: string) => `summary of ${sha}`;

describe("confirmCandidates", () => {
  it("checks newest first and splits confirmed, rejected and llmErrors", async () => {
    const llm = createFakeLlm([
      answer(true, "r0"),
      answer(false, "r1"),
      "garbage",
      answer(true, "r3"),
    ]);
    const out = await confirmCandidates(llm, candidates(4), { maxLlmChecks: 50 }, summarize);
    expect(llm.calls.map((c) => /summary of (\w+)/.exec(c.user)![1])).toEqual([
      "sha0",
      "sha1",
      "sha2",
      "sha3",
    ]);
    expect(out.confirmed.map((c) => [c.sha, c.llmReason])).toEqual([
      ["sha0", "r0"],
      ["sha3", "r3"],
    ]);
    expect(out.confirmed[0]!.matchedRules).toEqual(["keyword"]);
    expect(out.rejected).toEqual([{ sha: "sha1", message: "fix 1", reason: "r1" }]);
    expect(out.llmErrors).toHaveLength(1);
    expect(out.llmErrors[0]!.sha).toBe("sha2");
    expect(out.unchecked).toBe(0);
  });

  it("stops at limit and counts the rest as unchecked", async () => {
    const llm = createFakeLlm([answer(true)]);
    const out = await confirmCandidates(llm, candidates(5), { limit: 2, maxLlmChecks: 50 }, summarize);
    expect(out.confirmed).toHaveLength(2);
    expect(llm.calls).toHaveLength(2);
    expect(out.unchecked).toBe(3);
  });

  it("stops at maxLlmChecks, and errors count as checks", async () => {
    const llm = createFakeLlm(["garbage", answer(true), answer(true)]);
    const out = await confirmCandidates(llm, candidates(6), { maxLlmChecks: 3 }, summarize);
    expect(llm.calls).toHaveLength(3);
    expect(out.llmErrors).toHaveLength(1);
    expect(out.confirmed).toHaveLength(2);
    expect(out.unchecked).toBe(3);
  });

  it("throws 'LLM unreachable' after 3 transport errors at the start", async () => {
    const llm = createFakeLlm([new LlmNetworkError("down")]);
    const p = confirmCandidates(llm, candidates(10), { maxLlmChecks: 50 }, summarize);
    await expect(p).rejects.toThrow(HadesConfigError);
    await expect(p).rejects.toThrow("LLM unreachable");
    expect(llm.calls).toHaveLength(3);
  });

  it("does not throw when a success or invalid answer breaks the streak", async () => {
    const llm = createFakeLlm([
      new LlmHttpError(500, ""),
      "garbage",
      new LlmNetworkError("down"),
      new LlmNetworkError("down"),
      new LlmNetworkError("down"),
    ]);
    const out = await confirmCandidates(llm, candidates(5), { maxLlmChecks: 50 }, summarize);
    expect(out.llmErrors).toHaveLength(5);
  });

  it("does not throw 'unreachable' when fewer than 3 checks happen", async () => {
    const llm = createFakeLlm([new LlmNetworkError("down")]);
    const out = await confirmCandidates(llm, candidates(2), { maxLlmChecks: 50 }, summarize);
    expect(out.llmErrors).toHaveLength(2);
  });

  it("stops the run on an auth error", async () => {
    const llm = createFakeLlm([new LlmHttpError(401, "")]);
    await expect(
      confirmCandidates(llm, candidates(3), { maxLlmChecks: 50 }, summarize),
    ).rejects.toThrow("LLM endpoint returned 401");
  });

  it("falls back when the diff summary fails", async () => {
    const llm = createFakeLlm([answer(true)]);
    await confirmCandidates(llm, candidates(1), { maxLlmChecks: 5 }, async () => {
      throw new Error("no parent");
    });
    expect(llm.calls[0]!.user).toContain("(diff summary unavailable)");
  });

  it("handles no candidates", async () => {
    const out = await confirmCandidates(createFakeLlm([answer(true)]), [], { maxLlmChecks: 5 }, summarize);
    expect(out).toEqual({ confirmed: [], rejected: [], llmErrors: [], unchecked: 0 });
  });
});
