import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config.js";
import { HadesConfigError } from "../src/errors.js";

describe("resolveOptions", () => {
  it("fills every default", () => {
    expect(resolveOptions()).toEqual({
      testCommand: "npm test",
      timeoutMs: 120_000,
      maxCommits: 500,
      maxLlmChecks: 50,
      extraTestPatterns: [],
      extraNonCodePatterns: [],
      installTimeoutMs: 600_000,
      alwaysInstall: false,
      excerptChars: 4000,
      rerunOnFail: 0,
    });
  });

  it("keeps provided values", () => {
    const o = resolveOptions({ limit: 3, testCommand: "node check.mjs", rerunOnFail: 3 });
    expect(o.limit).toBe(3);
    expect(o.testCommand).toBe("node check.mjs");
    expect(o.rerunOnFail).toBe(3);
  });

  it("accepts alwaysInstall with installCommand", () => {
    const o = resolveOptions({ alwaysInstall: true, installCommand: "npm ci" });
    expect(o.alwaysInstall).toBe(true);
  });

  const rejected: [string, object][] = [
    ["alwaysInstall without installCommand", { alwaysInstall: true }],
    ["empty testCommand", { testCommand: "  " }],
    ["zero timeoutMs", { timeoutMs: 0 }],
    ["negative timeoutMs", { timeoutMs: -5 }],
    ["fractional limit", { limit: 1.5 }],
    ["zero limit", { limit: 0 }],
    ["zero maxCommits", { maxCommits: 0 }],
    ["zero maxLlmChecks", { maxLlmChecks: 0 }],
    ["zero installTimeoutMs", { installTimeoutMs: 0 }],
    ["zero excerptChars", { excerptChars: 0 }],
    ["empty installCommand", { installCommand: "" }],
    ["empty extra pattern", { extraTestPatterns: [""] }],
    ["non-array extraNonCodePatterns", { extraNonCodePatterns: "x" }],
    ["rerunOnFail above 3", { rerunOnFail: 4 }],
    ["negative rerunOnFail", { rerunOnFail: -1 }],
    ["unknown option", { bogus: 1 }],
  ];
  it.each(rejected)("rejects %s", (_name, input) => {
    expect(() => resolveOptions(input as never)).toThrow(HadesConfigError);
  });
});
