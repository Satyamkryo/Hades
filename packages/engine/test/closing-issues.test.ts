import { describe, expect, it } from "vitest";
import { matchRules } from "../src/history/candidates.js";
import {
  CLOSING_ISSUE,
  CLOSING_KEYWORDS,
  closingIssueNumbers,
} from "../src/history/closing-issues.js";

describe("closing issues", () => {
  it("keeps the keyword list used by matchRules", () => {
    expect([...CLOSING_KEYWORDS]).toEqual([
      "fix",
      "fixes",
      "fixed",
      "close",
      "closes",
      "closed",
      "resolve",
      "resolves",
      "resolved",
    ]);
    expect(CLOSING_ISSUE.test("Fixes #12")).toBe(true);
  });

  it("extracts sorted unique same-repo issue numbers", () => {
    expect(closingIssueNumbers("Fixes #12 and closes #7, fixes #12")).toEqual([7, 12]);
    expect(closingIssueNumbers("no keywords here #99")).toEqual([]);
  });

  it("ignores owner/repo references", () => {
    expect(closingIssueNumbers("see owner/repo#12")).toEqual([]);
    expect(closingIssueNumbers("Fixes #12, see owner/repo#34")).toEqual([12]);
  });

  it("agrees with matchRules on the closing-issue rule", () => {
    const messages = [
      "fix #1",
      "Fixes #12",
      "RESOLVED #3",
      "close  #44",
      "fix owner/repo#12",
      "see #12",
      "#12",
      "prefixfix #12",
      "fix#12",
      "",
    ];
    for (const message of messages) {
      expect(
        closingIssueNumbers(message).length > 0,
        JSON.stringify(message),
      ).toBe(matchRules(message).includes("closing-issue"));
    }
  });
});
