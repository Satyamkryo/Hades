import { z } from "zod";
import { HadesConfigError } from "./errors.js";
import type { LlmClient } from "./llm/types.js";

export interface ResurrectOptions {
  testCommand?: string;
  timeoutMs?: number;
  limit?: number;
  maxCommits?: number;
  maxLlmChecks?: number;
  extraTestPatterns?: string[];
  extraNonCodePatterns?: string[];
  installCommand?: string;
  installTimeoutMs?: number;
  alwaysInstall?: boolean;
  excerptChars?: number;
  /** Rerun failing tests this many times (0..3). Reruns are an optional feature. */
  rerunOnFail?: number;
}

export interface ResolvedOptions {
  testCommand: string;
  timeoutMs: number;
  limit?: number;
  maxCommits: number;
  maxLlmChecks: number;
  extraTestPatterns: string[];
  extraNonCodePatterns: string[];
  installCommand?: string;
  installTimeoutMs: number;
  alwaysInstall: boolean;
  excerptChars: number;
  rerunOnFail: number;
}

export interface ResurrectDeps {
  llm?: LlmClient;
  signal?: AbortSignal;
}

export const DEFAULT_OPTIONS = {
  testCommand: "npm test",
  timeoutMs: 120_000,
  maxCommits: 500,
  maxLlmChecks: 50,
  installTimeoutMs: 600_000,
  alwaysInstall: false,
  excerptChars: 4000,
  rerunOnFail: 0,
} as const;

const positiveInt = z.number().int().positive();
const nonEmpty = z.string().trim().min(1);

const optionsSchema = z
  .object({
    testCommand: nonEmpty.default(DEFAULT_OPTIONS.testCommand),
    timeoutMs: positiveInt.default(DEFAULT_OPTIONS.timeoutMs),
    limit: positiveInt.optional(),
    maxCommits: positiveInt.default(DEFAULT_OPTIONS.maxCommits),
    maxLlmChecks: positiveInt.default(DEFAULT_OPTIONS.maxLlmChecks),
    extraTestPatterns: z.array(nonEmpty).default([]),
    extraNonCodePatterns: z.array(nonEmpty).default([]),
    installCommand: nonEmpty.optional(),
    installTimeoutMs: positiveInt.default(DEFAULT_OPTIONS.installTimeoutMs),
    alwaysInstall: z.boolean().default(DEFAULT_OPTIONS.alwaysInstall),
    excerptChars: positiveInt.default(DEFAULT_OPTIONS.excerptChars),
    rerunOnFail: z.number().int().min(0).max(3).default(DEFAULT_OPTIONS.rerunOnFail),
  })
  .strict()
  .refine((o) => !o.alwaysInstall || o.installCommand !== undefined, {
    message: "alwaysInstall requires installCommand",
    path: ["alwaysInstall"],
  });

/** Validate options and fill defaults. Throws HadesConfigError before any git command runs. */
export function resolveOptions(input: ResurrectOptions = {}): ResolvedOptions {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "options"}: ${i.message}`)
      .join("; ");
    throw new HadesConfigError(`Invalid options: ${detail}`);
  }
  return parsed.data as ResolvedOptions;
}
