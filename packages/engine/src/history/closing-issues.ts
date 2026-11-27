// Closing-keyword rules shared by the summoning engine (`matchRules`) and the
// history reader (issue numbers for GitHub context).

export const CLOSING_KEYWORDS = [
  "fix",
  "fixes",
  "fixed",
  "close",
  "closes",
  "closed",
  "resolve",
  "resolves",
  "resolved",
] as const;

const ALTERNATION = CLOSING_KEYWORDS.join("|");

// Matches `matchRules`' old `CLOSING_ISSUE` behaviour exactly: a closing keyword
// followed by whitespace and a same-repo `#<digits>`. The look-behind keeps
// `owner/repo#12` from counting (the char before `#` there is `/`).
const SOURCE = `\\b(${ALTERNATION})\\s+(?<![\\w/])#(\\d+)\\b`;

/** True when the message closes a same-repo issue (`fix #12`). */
export const CLOSING_ISSUE: RegExp = new RegExp(SOURCE, "i");

/** Sorted, unique issue numbers closed by the text (same-repo `#n` only). */
export function closingIssueNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(new RegExp(SOURCE, "gi"))) {
    found.add(Number(match[2]));
  }
  return [...found].sort((a, b) => a - b);
}
