import { describe, expect, it } from "vitest";
import { HadesConfigError } from "../src/errors.js";
import { normalizeTargetFile, resolveAskOptions } from "../src/ask/options.js";

describe("resolveAskOptions", () => {
  it("fills defaults", () => {
    expect(resolveAskOptions({})).toEqual({
      maxCommits: 50,
      excerptChars: 4000,
      maxGithubRequests: 30,
      githubTimeoutMs: 10_000,
      githubTtlMs: 86_400_000,
      maxLlmChecks: 5,
    });
  });

  it("keeps valid lines, symbol and quota values", () => {
    const resolved = resolveAskOptions({
      lines: [10, 20],
      symbol: "myFunction",
      maxGithubRequests: 0,
      maxLlmChecks: 0,
    });
    expect(resolved.lines).toEqual([10, 20]);
    expect(resolved.symbol).toBe("myFunction");
    expect(resolved.maxGithubRequests).toBe(0);
    expect(resolved.maxLlmChecks).toBe(0);
  });

  it("rejects unknown keys", () => {
    expect(() => resolveAskOptions({ nope: 1 } as never)).toThrow(HadesConfigError);
  });

  it("rejects bad lines", () => {
    expect(() => resolveAskOptions({ lines: [20, 10] })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ lines: [0, 10] })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ lines: [1.5, 10] })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ lines: [10] as never })).toThrow(HadesConfigError);
  });

  it("rejects bad symbols", () => {
    expect(() => resolveAskOptions({ symbol: "" })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ symbol: "a".repeat(201) })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ symbol: "a:b" })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ symbol: "a\nb" })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ symbol: "a\rb" })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ symbol: "a\0b" })).toThrow(HadesConfigError);
  });

  it("rejects non-positive quotas", () => {
    expect(() => resolveAskOptions({ maxCommits: 0 })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ excerptChars: -1 })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ maxGithubRequests: -1 })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ githubTimeoutMs: 0 })).toThrow(HadesConfigError);
    expect(() => resolveAskOptions({ maxLlmChecks: -1 })).toThrow(HadesConfigError);
  });
});

describe("normalizeTargetFile", () => {
  const root = "E:\\repo";

  it("normalises separators and dot segments", () => {
    expect(normalizeTargetFile(root, "src\\foo.ts")).toBe("src/foo.ts");
    expect(normalizeTargetFile(root, "src/./foo.ts")).toBe("src/foo.ts");
    expect(normalizeTargetFile(root, "src/sub/../foo.ts")).toBe("src/foo.ts");
  });

  it("rejects empty and absolute paths", () => {
    expect(() => normalizeTargetFile(root, "")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "/abs/path.ts")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "C:\\abs\\path.ts")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "C:/abs/path.ts")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "\\\\server\\share\\f.ts")).toThrow(HadesConfigError);
  });

  it("rejects paths escaping the repo", () => {
    expect(() => normalizeTargetFile(root, "..")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "../out.ts")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, "a/../../out.ts")).toThrow(HadesConfigError);
    expect(() => normalizeTargetFile(root, ".")).toThrow(HadesConfigError);
  });
});
