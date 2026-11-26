import { describe, expect, it } from "vitest";
import { parseSummonArgs } from "../scripts/summon-args.js";

const repo = process.platform === "win32" ? "C:\\repo" : "/repo";

describe("parseSummonArgs", () => {
  it("parses --test-command and converts --timeout seconds to ms", () => {
    expect(parseSummonArgs([repo, "--test-command", "npm run t", "--timeout", "30"])).toEqual({
      ok: true, repo, testCommand: "npm run t", timeoutMs: 30_000,
    });
  });

  it("combines with --limit", () => {
    expect(parseSummonArgs([repo, "--limit", "3", "--timeout", "5"])).toEqual({
      ok: true, repo, limit: 3, timeoutMs: 5000,
    });
  });

  it("leaves absent options undefined", () => {
    const r = parseSummonArgs([repo]);
    expect(r).toEqual({ ok: true, repo });
    expect(r.ok && r.testCommand).toBeUndefined();
    expect(r.ok && r.timeoutMs).toBeUndefined();
  });

  it.each([
    ["empty command", ["--test-command", ""]],
    ["blank command", ["--test-command", "  "]],
    ["zero timeout", ["--timeout", "0"]],
    ["negative timeout", ["--timeout=-5"]],
    ["fractional timeout", ["--timeout", "1.5"]],
    ["non-numeric timeout", ["--timeout", "abc"]],
    ["empty timeout", ["--timeout", ""]],
    ["unknown option", ["--bogus"]],
    ["bad limit", ["--limit", "0"]],
  ])("rejects %s", (_name, extra) => {
    expect(parseSummonArgs([repo, ...extra]).ok).toBe(false);
  });

  it("rejects a missing or relative repo path", () => {
    expect(parseSummonArgs([]).ok).toBe(false);
    expect(parseSummonArgs(["rel/path"]).ok).toBe(false);
  });
});
