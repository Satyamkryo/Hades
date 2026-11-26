/** Default and limits for HADES_PROPERTY_RUNS (git-backed property runs). */
export const DEFAULT_PROPERTY_RUNS = 5;
export const DEFAULT_PROPERTY_TIMEOUT_MS = 240_000;

/**
 * Parse HADES_PROPERTY_RUNS. Unset or empty gives the default (5). Anything that is not a
 * plain integer from 1 to 100 throws, so a typo fails the test file at load time.
 */
export function parsePropertyRuns(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PROPERTY_RUNS;
  if (!/^\d+$/.test(raw)) throw new Error(`HADES_PROPERTY_RUNS must be an integer from 1 to 100, got "${raw}"`);
  const n = Number(raw);
  if (n < 1 || n > 100) throw new Error(`HADES_PROPERTY_RUNS must be an integer from 1 to 100, got "${raw}"`);
  return n;
}

/** Parse HADES_PROPERTY_TIMEOUT_MS (per-test timeout). Unset or empty gives 240 s. */
export function parsePropertyTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PROPERTY_TIMEOUT_MS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1000) {
    throw new Error(`HADES_PROPERTY_TIMEOUT_MS must be an integer of at least 1000, got "${raw}"`);
  }
  return Number(raw);
}
