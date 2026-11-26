import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeNonCodeMatcher, makeTestFileMatcher } from "../../src/classify/files.js";
import { extraPatternCase, fileTree, mixedFixScenario } from "./arbitraries.js";

describe("arbitraries", () => {
  it("mixed fix scenarios classify as intended and really change source files", () => {
    const isTest = makeTestFileMatcher();
    const isNonCode = makeNonCodeMatcher();
    fc.assert(
      fc.property(mixedFixScenario, (s) => {
        const paths = [...s.sourcePaths, ...s.testPaths, ...s.nonCodePaths];
        expect(new Set(paths).size).toBe(paths.length);
        for (const p of s.sourcePaths) {
          expect(isTest(p) || isNonCode(p)).toBe(false);
          expect(s.fixedContent[p]).not.toBe(s.baseContent[p]);
        }
        for (const p of s.testPaths) expect(isTest(p)).toBe(true);
        for (const p of s.nonCodePaths) expect(!isTest(p) && isNonCode(p)).toBe(true);
        expect(s.commits[s.fixIndex]?.message).toMatch(/^fix:/);
        for (const c of s.commits) for (const v of Object.values(c.files)) expect(v).not.toContain("\r");
      }),
      { numRuns: 100 },
    );
  });

  it("file trees and extra patterns are well formed", () => {
    fc.assert(
      fc.property(fileTree(), extraPatternCase, (tree, e) => {
        expect(Object.keys(tree).length).toBeGreaterThan(0);
        expect(makeTestFileMatcher([e.pattern])(e.matchingPath)).toBe(true);
        expect(makeTestFileMatcher([e.pattern])(e.otherPath)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
