import { z } from "zod";
import { redact } from "../report/redact.js";
import type { GithubTarget } from "./remote.js";
import type {
  GhIssue,
  GhPull,
  GhResult,
  GhReviewComment,
  GithubClient,
} from "./types.js";

const API = "https://api.github.com";

// The pulls response has no `merged` boolean; merge state comes from
// `merged_at` (`string | null`, always present), derived as `merged_at !== null`.
const pullSchema = z
  .object({
    number: z.number(),
    html_url: z.string(),
    body: z.string().nullable(),
    merged_at: z.string().nullable(),
  })
  .transform((p): GhPull => ({
    number: p.number,
    url: p.html_url,
    merged: p.merged_at !== null,
    body: p.body ?? "",
  }));

const pullsSchema = z.array(pullSchema);

const reviewCommentSchema = z
  .object({
    id: z.number(),
    html_url: z.string(),
    body: z.string().nullable(),
    created_at: z.string(),
  })
  .transform((c): GhReviewComment => ({
    id: c.id,
    url: c.html_url,
    body: c.body ?? "",
    createdAt: c.created_at,
  }));

const reviewCommentsSchema = z.array(reviewCommentSchema);

const issueSchema = z
  .object({
    number: z.number(),
    html_url: z.string(),
    body: z.string().nullable(),
  })
  .transform((i): GhIssue => ({ number: i.number, url: i.html_url, body: i.body ?? "" }));

export interface GithubClientOptions {
  token?: string;
  timeoutMs: number;
}

/**
 * Read-only GitHub client over plain `fetch` (GET only, no Octokit, so the
 * engine stays UI- and library-free). The token lives in this closure and is
 * only ever sent as an `Authorization` header; every message is redacted.
 */
export function createGithubClient(options: GithubClientOptions): GithubClient {
  const { token, timeoutMs } = options;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "hades-engine",
  };
  if (token !== undefined && token !== "") {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const safe = (message: string): string => redact(message, token);

  const rateLimitReset = (response: Response): string | undefined => {
    let resetAt: number | undefined;
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset !== null) {
      const seconds = Number.parseInt(reset, 10);
      if (Number.isFinite(seconds)) {
        resetAt = seconds * 1000;
      }
    }
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        const retryAt = Date.now() + seconds * 1000;
        const remaining = response.headers.get("x-ratelimit-remaining");
        const deadline =
          remaining === "0" && resetAt !== undefined ? Math.max(retryAt, resetAt) : retryAt;
        return new Date(deadline).toISOString();
      }
    }
    return resetAt === undefined ? undefined : new Date(resetAt).toISOString();
  };

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<GhResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: "error", message: safe(`GitHub request failed: ${message}`) };
    }
    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: "error", message: safe(`GitHub request failed: ${message}`) };
    }
    // The commit is not on GitHub (or the repo moved): a miss, not an error.
    if (response.status === 404 || response.status === 422) {
      return { ok: false, kind: "not-found" };
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (
        remaining === "0" ||
        response.headers.get("retry-after") !== null ||
        /rate limit/i.test(body)
      ) {
        const resetAt = rateLimitReset(response);
        return resetAt === undefined
          ? { ok: false, kind: "rate-limited" }
          : { ok: false, kind: "rate-limited", resetAt };
      }
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        kind: "error",
        message: safe(`GitHub request failed with status ${response.status}: ${body}`),
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      return { ok: false, kind: "error", message: "GitHub response was not JSON" };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, kind: "error", message: "GitHub response had an unexpected shape" };
    }
    return { ok: true, data: parsed.data };
  }

  const pullsPath = (target: GithubTarget, sha: string): string =>
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
    `/commits/${encodeURIComponent(sha)}/pulls`;

  return {
    commitPulls: (target, sha) => get(pullsPath(target, sha), pullsSchema),
    reviewComments: (target, pr) =>
      get(
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
          `/pulls/${encodeURIComponent(pr)}/comments?per_page=100`,
        reviewCommentsSchema,
      ),
    issue: (target, n) =>
      get(
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` +
          `/issues/${encodeURIComponent(n)}`,
        issueSchema,
      ),
  };
}
