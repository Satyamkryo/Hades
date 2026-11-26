import { describe, expect, it } from "vitest";
import { parsePropertyRuns, parsePropertyTimeoutMs } from "./helpers/property-runs.js";

describe("parsePropertyRuns", () => {
  it("defaults to 5 when unset or empty", () => {
    expect(parsePropertyRuns(undefined)).toBe(5);
    expect(parsePropertyRuns("")).toBe(5);
  });

  it("accepts integers 1..100", () => {
    for (const v of ["1", "20", "100"]) expect(parsePropertyRuns(v)).toBe(Number(v));
  });

  it("throws on invalid values", () => {
    for (const v of ["0", "101", "-3", "2.5", "abc", "20x", " 20", "1e1"]) {
      expect(() => parsePropertyRuns(v)).toThrow(/HADES_PROPERTY_RUNS/);
    }
  });
});

describe("parsePropertyTimeoutMs", () => {
  it("defaults to 240 s and accepts valid values", () => {
    expect(parsePropertyTimeoutMs(undefined)).toBe(240_000);
    expect(parsePropertyTimeoutMs("900000")).toBe(900_000);
  });

  it("throws on garbage or tiny values", () => {
    for (const v of ["abc", "-1", "999", "1.5"]) expect(() => parsePropertyTimeoutMs(v)).toThrow(/HADES_PROPERTY_TIMEOUT_MS/);
  });
});
