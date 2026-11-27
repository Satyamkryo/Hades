import type { GithubTarget } from "./remote.js";

export type { GithubTarget };

export interface GhPull {
  number: number;
  url: string;
  merged: boolean;
  body: string;
}

export interface GhReviewComment {
  id: number;
  url: string;
  body: string;
  createdAt: string;
}

export interface GhIssue {
  number: number;
  url: string;
  body: string;
}

export type GhResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "rate-limited"; resetAt?: string }
  | { ok: false; kind: "error"; message: string };

export interface GithubClient {
  commitPulls(target: GithubTarget, sha: string): Promise<GhResult<GhPull[]>>;
  /** Declared for the optional review-comments task; unused until it is built. */
  reviewComments(target: GithubTarget, pr: number): Promise<GhResult<GhReviewComment[]>>;
  issue(target: GithubTarget, n: number): Promise<GhResult<GhIssue>>;
}
