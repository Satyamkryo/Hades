import { throwIfAborted } from "../abort.js";
import { HadesConfigError } from "../errors.js";
import type { CommitInfo } from "../history/scan.js";
import type { CandidateRule, CommitNote } from "../report/types.js";
import { confirmFix } from "./confirm.js";
import type { LlmClient } from "./types.js";

export interface Candidate extends CommitInfo {
  matchedRules: CandidateRule[];
}

export interface ConfirmedFix extends Candidate {
  llmReason: string;
}

export interface ConfirmationOutcome {
  confirmed: ConfirmedFix[];
  rejected: CommitNote[];
  llmErrors: CommitNote[];
  /** Candidates never sent to the LLM because of `limit` or `maxLlmChecks`. */
  unchecked: number;
}

export interface ConfirmationOptions {
  limit?: number;
  maxLlmChecks: number;
}

/** After this many transport failures at the very start of a run, the endpoint is unreachable. */
const UNREACHABLE_AFTER = 3;

/**
 * Check Candidates with the LLM, newest first (the caller passes them in that order).
 * Stops when `limit` fixes are confirmed or `maxLlmChecks` calls were made; failed
 * calls count as checks. Throws HadesConfigError("LLM unreachable") if the first 3
 * checks all fail with HTTP or network errors, and lets auth errors (401/403/404) through.
 */
export async function confirmCandidates(
  client: LlmClient,
  candidates: Candidate[],
  options: ConfirmationOptions,
  summarize: (sha: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<ConfirmationOutcome> {
  const confirmed: ConfirmedFix[] = [];
  const rejected: CommitNote[] = [];
  const llmErrors: CommitNote[] = [];
  let checks = 0;
  let leadingTransportErrors = 0;

  for (const candidate of candidates) {
    throwIfAborted(signal);
    if (options.limit !== undefined && confirmed.length >= options.limit) break;
    if (checks >= options.maxLlmChecks) break;

    let summary: string;
    try {
      summary = await summarize(candidate.sha);
    } catch (e) {
      // An abort during the summary must stop the run, not fall back.
      throwIfAborted(signal);
      if ((e as Error)?.name === "HadesAbortError") throw e;
      summary = "(diff summary unavailable)";
    }

    throwIfAborted(signal);
    const result = await confirmFix(client, candidate, summary);
    checks++;

    const note = (reason: string): CommitNote => ({
      sha: candidate.sha,
      message: candidate.message,
      reason,
    });

    if (result.kind === "confirmed") {
      confirmed.push({ ...candidate, llmReason: result.reason });
    } else if (result.kind === "rejected") {
      rejected.push(note(result.reason));
    } else {
      llmErrors.push(note(result.reason));
    }

    if (checks <= UNREACHABLE_AFTER) {
      if (result.kind === "error" && result.transport) leadingTransportErrors++;
      if (checks === UNREACHABLE_AFTER && leadingTransportErrors === UNREACHABLE_AFTER) {
        throw new HadesConfigError("LLM unreachable");
      }
    }
  }

  return { confirmed, rejected, llmErrors, unchecked: candidates.length - checks };
}
