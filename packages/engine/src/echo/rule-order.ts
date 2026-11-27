import { NO_RECORD_TEXT, type Echo } from "../ask/types.js";
import type { Source } from "./sources.js";

/** Bump when the rule order changes, so cached echoes are recomputed. */
export const RULE_ORDER_VERSION = 1;

export const TRIVIAL_MESSAGES = [
  "wip",
  "update",
  "updates",
  "changes",
  "misc",
  "fix",
  "fixes",
  "tmp",
];

const MAX_QUOTE_CHARS = 300;

export interface RuleEchoMeta {
  prNumber?: number;
  issueNumbers: number[];
  /** PR URL, else the GitHub commit URL; used when the quoted source has none. */
  url?: string;
}

function cutQuote(text: string): { text: string; truncated: boolean } {
  const cut = text.trim();
  if (cut.length <= MAX_QUOTE_CHARS) {
    return { text: cut, truncated: false };
  }
  let excerpt = cut.slice(0, MAX_QUOTE_CHARS);
  if (/[\uD800-\uDBFF]$/.test(excerpt)) {
    excerpt = excerpt.slice(0, -1);
  }
  return { text: excerpt, truncated: true };
}

/**
 * Deterministic echo without an LLM: the first source (in rule order) that
 * says anything wins. Empty texts are skipped, as is a commit message that is
 * trivial on its own; trimming and cutting keep the quote a contiguous
 * substring of its source.
 */
export function ruleOrderEcho(sha: string, sources: Source[], meta: RuleEchoMeta): Echo {
  const base = { sha, prNumber: meta.prNumber, issueNumbers: meta.issueNumbers, url: meta.url };
  for (const source of sources) {
    const trimmed = source.text.trim();
    if (trimmed === "") {
      continue;
    }
    if (
      source.kind === "commit-message" &&
      (trimmed.length < 8 || TRIVIAL_MESSAGES.includes(trimmed.toLowerCase()))
    ) {
      continue;
    }
    const { text, truncated } = cutQuote(trimmed);
    return {
      ...base,
      confidence: "said",
      text,
      source: { kind: source.kind, ref: source.ref, url: source.url },
      truncated,
    };
  }
  return { ...base, confidence: "none", text: NO_RECORD_TEXT };
}
