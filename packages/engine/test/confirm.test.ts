import { describe, expect, it } from "vitest";
import { HadesConfigError } from "../src/errors.js";
import { LlmHttpError, LlmNetworkError } from "../src/llm/client.js";
import { confirmFix, stripFence, SYSTEM_PROMPT } from "../src/llm/confirm.js";
import { answer, createFakeLlm } from "./helpers/fake-llm.js";

const commit = { message: "fix: crash on empty input" };

describe("system prompt", () => {
  it("asks for JSON only and says a revert of a fix is not a bug fix", () => {
    expect(SYSTEM_PROMPT).toContain('{"isBugFix": boolean, "reason": string}');
    expect(SYSTEM_PROMPT).toMatch(/JSON only/);
    expect(SYSTEM_PROMPT).toMatch(/reverts a bug fix/);
    expect(SYSTEM_PROMPT).toMatch(/isBugFix false/);
  });
});

describe("stripFence", () => {
  it("removes json and bare fences, leaves plain text", () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("confirmFix", () => {
  it("confirmed", async () => {
    const llm = createFakeLlm([answer(true, "adds a null check")]);
    expect(await confirmFix(llm, commit, "diff here")).toEqual({
      kind: "confirmed",
      reason: "adds a null check",
    });
    expect(llm.calls[0]!.user).toContain("fix: crash on empty input");
    expect(llm.calls[0]!.user).toContain("diff here");
  });

  it("rejected", async () => {
    const r = await confirmFix(createFakeLlm([answer(false, "docs only")]), commit, "");
    expect(r).toEqual({ kind: "rejected", reason: "docs only" });
  });

  it("accepts a fenced answer", async () => {
    const r = await confirmFix(createFakeLlm(["```json\n" + answer(true) + "\n```"]), commit, "");
    expect(r.kind).toBe("confirmed");
  });

  it.each([
    ["not json", "nope"],
    ["wrong type", '{"isBugFix":"yes","reason":"x"}'],
    ["empty reason", '{"isBugFix":true,"reason":""}'],
    ["missing field", '{"isBugFix":true}'],
  ])("invalid answer (%s) is a non-transport error", async (_n, raw) => {
    const r = await confirmFix(createFakeLlm([raw]), commit, "");
    expect(r).toMatchObject({ kind: "error", transport: false });
    expect((r as { reason: string }).reason).toMatch(/invalid LLM response/);
  });

  it("HTTP 500 and network errors are transport errors", async () => {
    const http = await confirmFix(createFakeLlm([new LlmHttpError(500, "boom")]), commit, "");
    expect(http).toMatchObject({ kind: "error", transport: true });
    const net = await confirmFix(createFakeLlm([new LlmNetworkError("down")]), commit, "");
    expect(net).toEqual({ kind: "error", reason: "down", transport: true });
  });

  it.each([401, 403, 404])("HTTP %i throws HadesConfigError naming the status", async (status) => {
    const p = confirmFix(createFakeLlm([new LlmHttpError(status, "")]), commit, "");
    await expect(p).rejects.toThrow(HadesConfigError);
    await expect(p).rejects.toThrow(String(status));
  });
});
