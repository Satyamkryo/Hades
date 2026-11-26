import type { LlmClient } from "../../src/llm/types.js";

/** One scripted reply: a string is returned, an Error is thrown. */
export type FakeReply = string | Error;

export interface FakeLlm extends LlmClient {
  /** Every call, in order. */
  calls: { system: string; user: string }[];
}

/** Answer in the shape the engine asks for. */
export const answer = (isBugFix: boolean, reason = "because"): string =>
  JSON.stringify({ isBugFix, reason });

/**
 * Fake LLM client. `replies` are used in order; the last one repeats when they run out.
 * A function receives the user prompt and returns the reply, for content-based answers.
 */
export function createFakeLlm(replies: FakeReply[] | ((user: string) => FakeReply)): FakeLlm {
  const calls: FakeLlm["calls"] = [];
  return {
    calls,
    async complete(system, user) {
      calls.push({ system, user });
      const reply =
        typeof replies === "function"
          ? replies(user)
          : replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}
