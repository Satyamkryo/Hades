import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { matchRules } from "../src/history/candidates.js";

describe("matchRules", () => {
  it("matches keyword forms", () => {
    expect(matchRules("fixing the retry")).toEqual(["keyword"]);
    expect(matchRules("bugfix: null check")).toEqual(["keyword"]);
    expect(matchRules("Hotfix for crash")).toEqual(["keyword"]);
  });

  it("records both keyword and closing-issue for 'Fixes #12'", () => {
    expect(matchRules("Fixes #12")).toEqual(["keyword", "closing-issue"]);
  });

  it("matches closing-issue without a fix keyword", () => {
    expect(matchRules("Closes #7")).toEqual(["closing-issue"]);
  });

  it("does not match a bare issue reference", () => {
    expect(matchRules("update docs #123")).toEqual([]);
    expect(matchRules("add feature (#123)")).toEqual([]);
  });

  it("does not match keywords inside other words", () => {
    expect(matchRules("prefix the suffix")).toEqual([]);
  });

  it("matches a revert subject", () => {
    expect(matchRules('Revert "Fix x"')).toContain("revert");
    expect(matchRules('Revert "Add y"')).toEqual(["keyword", "revert"]);
  });

  it("matches the 'This reverts commit' body", () => {
    expect(matchRules("undo thing\n\nThis reverts commit abcdef1234567.")).toEqual(["revert"]);
  });
});

describe("matchRules properties", () => {
  // Words that contain none of the keyword/closing terms.
  const safeWord = fc.constantFrom("update", "add", "docs", "refactor", "rename", "feature", "tidy", "merge");

  it("a bare #N or (#N) with no keyword is never a Candidate", () => {
    // Validates: Requirements 2.2, 2.3
    fc.assert(
      fc.property(
        fc.array(safeWord, { minLength: 0, maxLength: 5 }),
        fc.nat({ max: 999_999 }),
        fc.boolean(),
        (words, n, parens) => {
          const ref = parens ? `(#${n})` : `#${n}`;
          const message = [...words, ref].join(" ");
          expect(matchRules(message)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
