import path from "node:path";
import { parseArgs } from "node:util";

export const USAGE =
  'Usage: summon <absolute repo path> [--limit N] [--test-command "<cmd>"] [--timeout <seconds>]';

export type SummonArgs =
  | { ok: true; repo: string; limit?: number; testCommand?: string; timeoutMs?: number }
  | { ok: false; error: string };

/** Pure argument parser: no I/O, never throws. Options that were not given stay absent. */
export function parseSummonArgs(argv: readonly string[]): SummonArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        limit: { type: "string" },
        "test-command": { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { values, positionals } = parsed;
  const repo = positionals[0];
  if (positionals.length !== 1 || repo === undefined || !path.isAbsolute(repo)) {
    return { ok: false, error: "expected exactly one absolute repo path" };
  }
  const out: { ok: true; repo: string; limit?: number; testCommand?: string; timeoutMs?: number } = {
    ok: true,
    repo,
  };
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: "--limit must be a positive integer" };
    }
    out.limit = limit;
  }
  const command = values["test-command"];
  if (command !== undefined) {
    if (command.trim() === "") return { ok: false, error: "--test-command must not be empty" };
    out.testCommand = command;
  }
  if (values.timeout !== undefined) {
    // Digits only: rejects "", "-5", "1.5", "1e3", "abc". Zero is rejected below.
    const seconds = /^\d+$/.test(values.timeout) ? Number(values.timeout) : NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 1) {
      return { ok: false, error: "--timeout must be a positive whole number of seconds" };
    }
    out.timeoutMs = seconds * 1000;
  }
  return out;
}
