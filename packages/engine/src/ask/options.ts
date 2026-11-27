import path from "node:path";
import { z } from "zod";
import { HadesConfigError } from "../errors.js";

export interface AskHistoryOptions {
  lines?: [number, number];
  symbol?: string;
  maxCommits?: number;
  excerptChars?: number;
  maxGithubRequests?: number;
  githubTimeoutMs?: number;
  githubTtlMs?: number;
  maxLlmChecks?: number;
}

export interface ResolvedAskOptions {
  lines?: [number, number];
  symbol?: string;
  maxCommits: number;
  excerptChars: number;
  maxGithubRequests: number;
  githubTimeoutMs: number;
  githubTtlMs: number;
  maxLlmChecks: number;
}

const positiveInt = z.number().int().positive();
/** 0 turns the feature off (GitHub context, LLM echoes). */
const nonNegativeInt = z.number().int().min(0);

const askOptionsSchema = z
  .object({
    lines: z
      .tuple([positiveInt, positiveInt])
      .refine(([start, end]) => start <= end, {
        message: "lines start must be <= end",
      })
      .optional(),
    symbol: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[:\n\r\0]/.test(s), {
        message: 'symbol must not contain ":", newline or NUL',
      })
      .optional(),
    maxCommits: positiveInt.default(50),
    excerptChars: positiveInt.default(4000),
    maxGithubRequests: nonNegativeInt.default(30),
    githubTimeoutMs: positiveInt.default(10_000),
    githubTtlMs: positiveInt.default(86_400_000),
    maxLlmChecks: nonNegativeInt.default(5),
  })
  .strict();

/** Validate options and fill defaults. Throws HadesConfigError before any git call. */
export function resolveAskOptions(input: AskHistoryOptions = {}): ResolvedAskOptions {
  const parsed = askOptionsSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "options"}: ${i.message}`)
      .join("; ");
    throw new HadesConfigError(`Invalid options: ${detail}`);
  }
  return parsed.data;
}

/**
 * Normalise a user-supplied target file to a repo-relative path with `/`
 * separators. Rejects empty and absolute paths (checked with both POSIX and
 * Windows rules, so `C:\\x` and UNC paths fail everywhere) and anything that
 * escapes the repo root. The file does not have to exist: deleted files have
 * history too. Throws HadesConfigError before any git call.
 */
export function normalizeTargetFile(_repoRoot: string, file: string): string {
  if (file === "") {
    throw new HadesConfigError("Invalid file: path is empty");
  }
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
    throw new HadesConfigError("Invalid file: absolute paths are not allowed");
  }
  const normalised = path.posix.normalize(file.replace(/\\/g, "/"));
  if (normalised === "." || normalised === ".." || normalised.startsWith("../")) {
    throw new HadesConfigError("Invalid file: path escapes the repo");
  }
  return normalised;
}
