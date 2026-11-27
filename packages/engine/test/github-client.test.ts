import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubClient } from "../src/github/client.js";
import type { GhPull } from "../src/github/types.js";

const TARGET = { owner: "octo", repo: "lib" };
const SHA = "a".repeat(40);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => unknown): void {
  vi.stubGlobal("fetch", (url: unknown, init: unknown) =>
    Promise.resolve(handler(url as string, (init ?? {}) as RequestInit)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fullPull(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 7,
    html_url: "https://github.com/octo/lib/pull/7",
    body: "fixes the bug",
    user: { login: "octo", id: 1 },
    head: { sha: SHA },
    base: { ref: "main" },
    extra_unrelated_field: [1, 2, 3],
    ...overrides,
  };
}

describe("createGithubClient", () => {
  it("sends GET requests with pinned headers and the token only in Authorization", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return jsonResponse([]);
    });
    const client = createGithubClient({ token: "secret-token-123", timeoutMs: 10_000 });
    const result = await client.commitPulls(TARGET, SHA);
    expect(result).toEqual({ ok: true, data: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://api.github.com/repos/octo/lib/commits/${SHA}/pulls`);
    expect(seen[0]?.init.method).toBe("GET");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["User-Agent"]).toBe("hades-engine");
    expect(headers["Authorization"]).toBe("Bearer secret-token-123");
  });

  it("omits Authorization without a token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    stubFetch((url, init) => {
      seen.push({ url, init });
      return jsonResponse({ number: 1, html_url: "u", body: null });
    });
    const client = createGithubClient({ timeoutMs: 10_000 });
    await client.issue(TARGET, 1);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect("Authorization" in headers).toBe(false);
  });

  it("parses merge state from merged_at", async () => {
    stubFetch(() =>
      jsonResponse([
        fullPull({ number: 7, merged_at: "2024-05-01T12:00:00Z" }),
        fullPull({ number: 9, merged_at: null, body: null }),
      ]),
    );
    const client = createGithubClient({ timeoutMs: 10_000 });
    const result = await client.commitPulls(TARGET, SHA);
    expect(result).toEqual({
      ok: true,
      data: [
        {
          number: 7,
          url: "https://github.com/octo/lib/pull/7",
          merged: true,
          body: "fixes the bug",
        },
        {
          number: 9,
          url: "https://github.com/octo/lib/pull/7",
          merged: false,
          body: "",
        } satisfies GhPull,
      ],
    });
  });

  it("treats a missing merged_at as a schema error", async () => {
    const { merged_at: _dropped, ...withoutMergedAt } = fullPull({ number: 7 });
    void _dropped;
    stubFetch(() => jsonResponse([withoutMergedAt]));
    const client = createGithubClient({ timeoutMs: 10_000 });
    const result = await client.commitPulls(TARGET, SHA);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.message).toContain("unexpected shape");
    } else {
      expect.unreachable();
    }
  });

  it("maps 404 and 422 to not-found", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    const client = createGithubClient({ timeoutMs: 10_000 });
    expect(await client.commitPulls(TARGET, SHA)).toEqual({ ok: false, kind: "not-found" });
    vi.unstubAllGlobals();
    stubFetch(() => new Response("nope", { status: 422 }));
    expect(await client.issue(TARGET, 1)).toEqual({ ok: false, kind: "not-found" });
  });

  it("detects rate limits from headers and bodies", async () => {
    stubFetch(() =>
      jsonResponse({ message: "ignored" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2000000000",
      }),
    );
    const client = createGithubClient({ timeoutMs: 10_000 });
    expect(await client.commitPulls(TARGET, SHA)).toEqual({
      ok: false,
      kind: "rate-limited",
      resetAt: new Date(2000000000 * 1000).toISOString(),
    });

    vi.unstubAllGlobals();
    stubFetch(() => jsonResponse({ message: "x" }, 429, { "retry-after": "120" }));
    const second = await client.issue(TARGET, 1);
    expect(second.ok).toBe(false);
    if (!second.ok && second.kind === "rate-limited" && second.resetAt !== undefined) {
      const skew = Math.abs(Date.parse(second.resetAt) - (Date.now() + 120_000));
      expect(skew).toBeLessThan(60_000);
    } else {
      expect.unreachable();
    }

    vi.unstubAllGlobals();
    stubFetch(() => jsonResponse({ message: "API rate limit exceeded" }, 403));
    expect(await client.issue(TARGET, 2)).toEqual({ ok: false, kind: "rate-limited" });
  });

  it("uses retry-after for secondary limits and waits for both primary delays", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const client = createGithubClient({ timeoutMs: 10_000 });
    stubFetch(() => jsonResponse({ message: "secondary rate limit" }, 429, {
      "x-ratelimit-remaining": "10",
      "x-ratelimit-reset": "2000000240",
      "retry-after": "120",
    }));
    const secondary = await client.issue(TARGET, 1);
    expect(secondary).toEqual({
      ok: false,
      kind: "rate-limited",
      resetAt: new Date(2_000_000_120_000).toISOString(),
    });

    stubFetch(() => jsonResponse({ message: "primary rate limit" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "2000000240",
      "retry-after": "120",
    }));
    const primary = await client.issue(TARGET, 2);
    expect(primary).toEqual({
      ok: false,
      kind: "rate-limited",
      resetAt: new Date(2_000_000_240_000).toISOString(),
    });
  });

  it("treats other statuses as errors", async () => {
    stubFetch(() => new Response("boom", { status: 401 }));
    const client = createGithubClient({ timeoutMs: 10_000 });
    const result = await client.issue(TARGET, 1);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "error" });
  });

  it("redacts the token from messages", async () => {
    stubFetch(() => new Response("token secret-token-123 leaked", { status: 500 }));
    const client = createGithubClient({ token: "secret-token-123", timeoutMs: 10_000 });
    const result = await client.issue(TARGET, 1);
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.message).not.toContain("secret-token-123");
      expect(result.message).toContain("***");
    } else {
      expect.unreachable();
    }

    vi.unstubAllGlobals();
    stubFetch(() => Promise.reject(new Error("net secret-token-123 down")));
    const thrown = await client.issue(TARGET, 2);
    expect(thrown.ok).toBe(false);
    if (!thrown.ok && thrown.kind === "error") {
      expect(thrown.message).not.toContain("secret-token-123");
    } else {
      expect.unreachable();
    }
  });

  it("turns a timeout into a failed call, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out", "TimeoutError")),
          );
        }),
    );
    const client = createGithubClient({ timeoutMs: 30 });
    const result = await client.commitPulls(TARGET, SHA);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "error" });
  });
});
