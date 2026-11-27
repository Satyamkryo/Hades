import type {
  GhIssue,
  GhPull,
  GhResult,
  GhReviewComment,
  GithubClient,
  GithubTarget,
} from "../../src/github/types.js";

export interface FakeGithubDataset {
  /** PRs returned for a commit SHA; a missing SHA means no linked PRs. */
  pulls: Record<string, GhPull[]>;
  comments: Record<number, GhReviewComment[]>;
  /** A missing issue number is a 404. */
  issues: Record<number, GhIssue>;
}

export type FakeGithubAnswer = "rate-limited" | "not-found" | { error: string };

export interface FakeGithubScripts {
  pulls?: Record<string, FakeGithubAnswer>;
  comments?: Record<number, FakeGithubAnswer>;
  issues?: Record<number, FakeGithubAnswer>;
}

export interface FakeGithubCalls {
  pulls: { target: GithubTarget; sha: string }[];
  comments: { target: GithubTarget; pr: number }[];
  issues: { target: GithubTarget; n: number }[];
}

export interface FakeGithub {
  client: GithubClient;
  calls: FakeGithubCalls;
}

const EMPTY_DATASET: FakeGithubDataset = { pulls: {}, comments: {}, issues: {} };

function scripted(answer: FakeGithubAnswer | undefined): GhResult<never> | undefined {
  if (answer === undefined) {
    return undefined;
  }
  if (answer === "rate-limited") {
    return { ok: false, kind: "rate-limited" };
  }
  if (answer === "not-found") {
    return { ok: false, kind: "not-found" };
  }
  return { ok: false, kind: "error", message: answer.error };
}

/**
 * In-memory GithubClient for tests. Answers come from the dataset, overridden
 * by per-SHA/PR/issue scripts; every call is recorded so tests can assert the
 * budget order and the warm-cache retry set.
 */
export function createFakeGithub(
  dataset: FakeGithubDataset = EMPTY_DATASET,
  scripts: FakeGithubScripts = {},
): FakeGithub {
  const calls: FakeGithubCalls = { pulls: [], comments: [], issues: [] };
  const client: GithubClient = {
    commitPulls: (target, sha) => {
      calls.pulls.push({ target, sha });
      const forced = scripted(scripts.pulls?.[sha]);
      if (forced !== undefined) {
        return Promise.resolve(forced);
      }
      return Promise.resolve({ ok: true as const, data: dataset.pulls[sha] ?? [] });
    },
    reviewComments: (target, pr) => {
      calls.comments.push({ target, pr });
      const forced = scripted(scripts.comments?.[pr]);
      if (forced !== undefined) {
        return Promise.resolve(forced);
      }
      return Promise.resolve({ ok: true as const, data: dataset.comments[pr] ?? [] });
    },
    issue: (target, n) => {
      calls.issues.push({ target, n });
      const forced = scripted(scripts.issues?.[n]);
      if (forced !== undefined) {
        return Promise.resolve(forced as GhResult<GhIssue>);
      }
      const found = dataset.issues[n];
      return Promise.resolve(
        found === undefined ? { ok: false as const, kind: "not-found" as const } : { ok: true as const, data: found },
      );
    },
  };
  return { client, calls };
}
