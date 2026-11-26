import { z } from "zod";
import { HadesConfigError } from "../errors.js";
import { LlmHttpError, LlmNetworkError } from "./client.js";
import type { LlmClient } from "./types.js";

export const SYSTEM_PROMPT = [
  "You decide whether a git commit fixed a bug in the code.",
  'Answer with JSON only, exactly in this shape: {"isBugFix": boolean, "reason": string}.',
  "Do not add Markdown, code fences or any other text.",
  "A commit that only mentions \"fix\" in passing (typos, docs, formatting, dependency bumps) is not a bug fix.",
  'A commit that reverts a bug fix (for example `Revert "Fix ..."`) is not a bug fix: answer isBugFix false.',
  "Keep the reason to one short sentence.",
].join("\n");

const answerSchema = z.object({
  isBugFix: z.boolean(),
  reason: z.string().min(1).max(500),
});

export type ConfirmResult =
  | { kind: "confirmed"; reason: string }
  | { kind: "rejected"; reason: string }
  /** `transport` is true for HTTP and network failures, false for an invalid answer. */
  | { kind: "error"; reason: string; transport: boolean };

/** Strip one optional Markdown code fence around the model's answer. */
export function stripFence(text: string): string {
  const m = /^\s*```[A-Za-z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return (m ? m[1]! : text).trim();
}

function buildUserPrompt(message: string, summary: string): string {
  return `Commit message:\n${message}\n\nChanges (stat and start of the patch):\n${summary}`;
}

/**
 * Ask the LLM whether a commit is a bug fix.
 * 401/403/404 mean the endpoint, key or model is wrong: they throw HadesConfigError and
 * stop the run. Every other failure is returned as an `error` result.
 */
export async function confirmFix(
  client: LlmClient,
  commit: { message: string },
  diffSummary: string,
): Promise<ConfirmResult> {
  let raw: string;
  try {
    raw = await client.complete(SYSTEM_PROMPT, buildUserPrompt(commit.message, diffSummary));
  } catch (err) {
    if (err instanceof LlmHttpError) {
      if (err.status === 401 || err.status === 403 || err.status === 404) {
        throw new HadesConfigError(`LLM endpoint returned ${err.status}`);
      }
      return { kind: "error", reason: err.message, transport: true };
    }
    if (err instanceof LlmNetworkError) {
      return { kind: "error", reason: err.message, transport: true };
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(stripFence(raw));
  } catch {
    return { kind: "error", reason: "invalid LLM response: not valid JSON", transport: false };
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "error", reason: "invalid LLM response: unexpected shape", transport: false };
  }
  return parsed.data.isBugFix
    ? { kind: "confirmed", reason: parsed.data.reason }
    : { kind: "rejected", reason: parsed.data.reason };
}
