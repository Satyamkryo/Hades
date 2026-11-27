import type { CommitContext } from "../github/context.js";
import type { GithubTarget } from "../github/remote.js";
import type { HistoryCommit } from "../ask/types.js";

export type SourceKind = "commit-message" | "pr-body" | "review-comment" | "issue-body";

export interface Source {
  id: string;
  kind: SourceKind;
  /** SHA, PR number, issue number or comment id, as a string. */
  ref: string;
  url?: string;
  text: string;
}

function commitUrl(target: GithubTarget | undefined, sha: string): string | undefined {
  if (target === undefined) {
    return undefined;
  }
  return `https://github.com/${target.owner}/${target.repo}/commit/${sha}`;
}

/**
 * Collect the records the echo may quote, in rule order: commit message, PR
 * body, issues ascending, then review comments (omitted until the optional
 * task that produces them). URLs come only from GitHub responses, except the
 * commit URL built in GitHub mode.
 */
export function collectSources(
  commit: HistoryCommit,
  ctx: CommitContext | undefined,
  target: GithubTarget | undefined,
): Source[] {
  const sources: Source[] = [
    {
      id: "commit",
      kind: "commit-message",
      ref: commit.sha,
      url: commitUrl(target, commit.sha),
      text: commit.message,
    },
  ];
  if (ctx?.pr !== undefined) {
    sources.push({ id: "pr", kind: "pr-body", ref: String(ctx.pr.number), url: ctx.pr.url, text: ctx.pr.body });
  }
  for (const issue of [...(ctx?.issues ?? [])].sort((a, b) => a.number - b.number)) {
    sources.push({
      id: `issue-${issue.number}`,
      kind: "issue-body",
      ref: String(issue.number),
      url: issue.url,
      text: issue.body,
    });
  }
  return sources;
}
