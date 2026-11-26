import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isDependencyFile,
  makeNonCodeMatcher,
  makeTestFileMatcher,
  selectFiles,
} from "../src/classify/files.js";

describe("test file matcher", () => {
  const isTest = makeTestFileMatcher([]);
  it.each([
    "a.test.ts",
    "src/a.spec.js",
    "src/__tests__/a.ts",
    "src/__mocks__/a.ts",
    "test/a.ts",
    "packages/x/tests/a.ts",
    "src/fixtures/a.json",
    ".hidden/test/a.ts",
  ])("matches %s", (p) => expect(isTest(p)).toBe(true));
  it.each(["src/a.ts", "src/latest.ts", "contest/a.ts"])("does not match %s", (p) =>
    expect(isTest(p)).toBe(false),
  );
  it("honours extra patterns", () => {
    expect(makeTestFileMatcher(["**/e2e/**"])("e2e/a.ts")).toBe(true);
  });
});

describe("non-code matcher", () => {
  const isNonCode = makeNonCodeMatcher([]);
  it.each([
    "README.md",
    "docs/a.ts",
    "a/b.mdx",
    "notes.txt",
    ".github/workflows/ci.yml",
    "LICENSE",
    "CHANGELOG.md",
    ".vscode/settings.json",
    ".kiro/specs/a.json",
  ])("matches %s", (p) => expect(isNonCode(p)).toBe(true));
  it("does not match source", () => expect(isNonCode("src/a.ts")).toBe(false));
  it("honours extra patterns", () => {
    expect(makeNonCodeMatcher(["**/*.yml"])("ci.yml")).toBe(true);
  });
});

describe("isDependencyFile", () => {
  it.each(["package.json", "a/b/yarn.lock", "pnpm-lock.yaml", "x\\bun.lockb", "bun.lock"])(
    "true for %s",
    (p) => expect(isDependencyFile(p)).toBe(true),
  );
  it.each(["src/package.json.ts", "tsconfig.json"])("false for %s", (p) =>
    expect(isDependencyFile(p)).toBe(false),
  );
});

describe("selectFiles", () => {
  it("splits paths into source, test and non-code", () => {
    const sel = selectFiles(
      ["src/a.ts", "src/a.test.ts", "README.md", "package.json", "docs/package.json"],
      { isTest: makeTestFileMatcher([]), isNonCode: makeNonCodeMatcher([]) },
    );
    expect(sel.source).toEqual(["src/a.ts", "package.json"]);
    expect(sel.skippedTest).toEqual(["src/a.test.ts"]);
    expect(sel.skippedNonCode).toEqual(["README.md", "docs/package.json"]);
    expect(sel.nonTest).toEqual(["src/a.ts", "README.md", "package.json", "docs/package.json"]);
  });
});

describe("separator agreement", () => {
  // **Validates: Requirements 4.1, 4.2**
  const segment = fc.constantFrom(
    "src", "test", "tests", "docs", "__tests__", "fixtures", ".github", "lib",
    "a.test.ts", "b.spec.js", "README.md", "LICENSE", "index.ts", "package.json",
  );
  const pathArb = fc.array(segment, { minLength: 1, maxLength: 5 });
  it("matchers give the same answer for / and \\", () => {
    const isTest = makeTestFileMatcher([]);
    const isNonCode = makeNonCodeMatcher([]);
    fc.assert(
      fc.property(pathArb, (segs) => {
        const fwd = segs.join("/");
        const back = segs.join("\\");
        expect(isTest(back)).toBe(isTest(fwd));
        expect(isNonCode(back)).toBe(isNonCode(fwd));
        expect(isDependencyFile(back)).toBe(isDependencyFile(fwd));
      }),
      { numRuns: 100 },
    );
  });
});
