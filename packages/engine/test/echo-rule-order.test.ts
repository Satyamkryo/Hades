import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NO_RECORD_TEXT } from "../src/ask/types.js";
import { ruleOrderEcho, TRIVIAL_MESSAGES } from "../src/echo/rule-order.js";
import type { Source } from "../src/echo/sources.js";

const SHA = "a".repeat(40);

function source(id: string, text: string, kind: Source["kind"] = "commit-message"): Source {
  return { id, kind, ref: id, text };
}

describe("ruleOrderEcho", () => {
  it("quotes the commit message first", () => {
    const echo = ruleOrderEcho(
      SHA,
      [source("commit", "  fixed the timeout  "), source("pr", "pr body")],
      { issueNumbers: [] },
    );
    expect(echo).toMatchObject({ confidence: "said", text: "fixed the timeout" });
    expect(echo.source).toEqual({ kind: "commit-message", ref: "commit", url: undefined });
    expect(echo.truncated).toBe(false);
  });

  it("falls through to the PR body past trivial messages", () => {
    for (const trivial of [...TRIVIAL_MESSAGES, "WIP", "Fix", "x"]) {
      const echo = ruleOrderEcho(
        SHA,
        [source("commit", trivial), source("pr", "explains it", "pr-body")],
        {
        issueNumbers: [3],
        prNumber: 9,
        url: "https://example.invalid/pr",
      });
      expect(echo.text).toBe("explains it");
      expect(echo.source?.kind).toBe("pr-body");
      expect(echo.prNumber).toBe(9);
      expect(echo.issueNumbers).toEqual([3]);
    }
  });

  it("skips empty texts and cuts long quotes without splitting surrogates", () => {
    const echo = ruleOrderEcho(
      SHA,
      [source("commit", "   "), source("pr", `xy\u{1F600}${"z".repeat(400)}`)],
      { issueNumbers: [] },
    );
    expect(echo.confidence).toBe("said");
    expect(echo.text?.length).toBeLessThanOrEqual(300);
    expect(echo.truncated).toBe(true);
  });

  it("returns the none echo when nothing says anything", () => {
    const echo = ruleOrderEcho(SHA, [source("commit", "wip"), source("pr", "  ")], {
      prNumber: 4,
      issueNumbers: [],
      url: "https://example.invalid/commit",
    });
    expect(echo).toEqual({
      sha: SHA,
      prNumber: 4,
      issueNumbers: [],
      url: "https://example.invalid/commit",
      confidence: "none",
      text: NO_RECORD_TEXT,
    });
  });

  it("always quotes a substring of one source within 300 chars", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            kind: fc.constantFrom("commit-message", "pr-body", "issue-body", "review-comment"),
            text: fc.string({ maxLength: 600 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (raw) => {
          const sources: Source[] = raw.map((s, i) => ({ ...s, ref: String(i) }));
          const echo = ruleOrderEcho(SHA, sources, { issueNumbers: [] });
          if (echo.confidence === "said") {
            expect(echo.text.length).toBeLessThanOrEqual(300);
            expect(echo.source).toBeDefined();
            const source = sources.find(
              (s) => s.kind === echo.source?.kind && s.ref === echo.source?.ref,
            );
            expect(source).toBeDefined();
            expect(source!.text.includes(echo.text)).toBe(true);
          } else {
            expect(echo.text).toBe(NO_RECORD_TEXT);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
