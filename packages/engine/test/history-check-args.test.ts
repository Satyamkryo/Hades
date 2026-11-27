import { describe, expect, it } from "vitest";
import { parseHistoryCheckArgs } from "../scripts/history-check-args.js";

const repo = process.platform === "win32" ? "C:\\repo" : "/repo";

describe("parseHistoryCheckArgs", () => {
  it("parses repo, file, lines and symbol", () => {
    expect(parseHistoryCheckArgs([repo, "src/a.ts", "--lines", "10,20", "--symbol", "parse"])).toEqual({
      ok: true,
      repo,
      file: "src/a.ts",
      lines: [10, 20],
      symbol: "parse",
      noLlm: false,
      noGithub: false,
    });
  });

  it("parses flags and leaves absent options undefined", () => {
    expect(parseHistoryCheckArgs([repo, "src/a.ts", "--no-llm", "--no-github"])).toEqual({
      ok: true,
      repo,
      file: "src/a.ts",
      noLlm: true,
      noGithub: true,
    });
    const r = parseHistoryCheckArgs([repo, "src/a.ts"]);
    expect(r).toEqual({ ok: true, repo, file: "src/a.ts", noLlm: false, noGithub: false });
    expect(r.ok && r.lines).toBeUndefined();
    expect(r.ok && r.symbol).toBeUndefined();
  });

  it.each([
    ["missing file", [repo]],
    ["missing paths", []],
    ["extra positional", [repo, "a.ts", "b.ts"]],
    ["relative repo", ["rel/path", "a.ts"]],
    ["empty file", [repo, ""]],
    ["bad lines", [repo, "a.ts", "--lines", "10"]],
    ["lines words", [repo, "a.ts", "--lines", "a,b"]],
    ["lines zero", [repo, "a.ts", "--lines", "0,20"]],
    ["lines negative", [repo, "a.ts", "--lines=-5,20"]],
    ["empty symbol", [repo, "a.ts", "--symbol", ""]],
    ["unknown option", [repo, "a.ts", "--bogus"]],
  ])("rejects %s", (_name, extra) => {
    expect(parseHistoryCheckArgs(extra).ok).toBe(false);
  });
});
