import { redact } from "../report/redact.js";
import type { LlmEnv } from "./env.js";
import type { LlmClient } from "./types.js";

/** The endpoint answered with a non-2xx status. */
export class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`LLM endpoint returned ${status}${body ? `: ${body}` : ""}`);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

/** The request failed before an HTTP answer arrived (connection error or timeout). */
export class LlmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmNetworkError";
  }
}

export interface ClientOptions {
  timeoutMs?: number;
}

const MAX_ERROR_BODY = 500;

/** Pull `choices[0].message.content` out of a chat completions body; fall back to the raw text. */
function extractContent(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const content = (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
      ?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // Not JSON: the caller's validation reports it as an invalid response.
  }
  return body;
}

/**
 * OpenAI-compatible chat completions client using Node's built-in fetch.
 * `response_format` is not sent (not every compatible server accepts it).
 * The API key is removed from every error message and is never logged.
 */
export function createOpenAiCompatibleClient(cfg: LlmEnv, options: ClientOptions = {}): LlmClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const safe = (text: string): string => redact(text, cfg.apiKey);

  return {
    async complete(system: string, user: string): Promise<string> {
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new LlmNetworkError(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        const cause = (err as { cause?: { message?: string } }).cause?.message;
        const message = err instanceof Error ? err.message : String(err);
        throw new LlmNetworkError(safe(`LLM request failed: ${cause ?? message}`));
      }

      if (!response.ok) {
        throw new LlmHttpError(response.status, safe(text.trim()).slice(0, MAX_ERROR_BODY));
      }
      return extractContent(text);
    },
  };
}
