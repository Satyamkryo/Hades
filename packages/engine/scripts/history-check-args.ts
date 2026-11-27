import path from "node:path";
import { parseArgs } from "node:util";

export const USAGE =
  "Usage: history-check <absolute repo path> <file> [--lines a,b] [--symbol name] [--no-llm] [--no-github]";

export type HistoryCheckArgs =
  | {
    ok: true;
    repo: string;
    file: string;
    lines?: [number, number];
    symbol?: string;
    noLlm: boolean;
    noGithub: boolean;
  }
  | { ok: false; error: string };

/** Pure argument parser: no I/O, never throws. Options that were not given stay absent. */
export function parseHistoryCheckArgs(argv: readonly string[]): HistoryCheckArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        lines: { type: "string" },
        symbol: { type: "string" },
        "no-llm": { type: "boolean" },
        "no-github": { type: "boolean" },
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { values, positionals } = parsed;
  const [repo, file] = positionals;
  if (positionals.length !== 2 || repo === undefined || file === undefined) {
    return { ok: false, error: "expected exactly one absolute repo path and one file" };
  }
  if (!path.isAbsolute(repo)) {
    return { ok: false, error: "repo path must be absolute" };
  }
  if (file === "") {
    return { ok: false, error: "file must not be empty" };
  }
  const out: {
    ok: true;
    repo: string;
    file: string;
    lines?: [number, number];
    symbol?: string;
    noLlm: boolean;
    noGithub: boolean;
  } = { ok: true, repo, file, noLlm: values["no-llm"] ?? false, noGithub: values["no-github"] ?? false };
  if (values.lines !== undefined) {
    const match = /^(\d+),(\d+)$/.exec(values.lines);
    if (match === null) {
      return { ok: false, error: "--lines must look like 10,20" };
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < 1) {
      return { ok: false, error: "--lines must be two positive integers" };
    }
    out.lines = [start, end];
  }
  if (values.symbol !== undefined) {
    if (values.symbol === "") {
      return { ok: false, error: "--symbol must not be empty" };
    }
    out.symbol = values.symbol;
  }
  return out;
}
