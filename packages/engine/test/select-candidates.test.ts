import { describe, expect, it } from "vitest";
import { matchRules, selectCandidates } from "../src/history/candidates.js";
import type { CommitInfo } from "../src/history/scan.js";
import { confirmCandidates } from "../src/llm/confirm-loop.js";
import { answer, createFakeLlm } from "./helpers/fake-llm.js";

/** Newest first. `fixEvery` makes every Nth message match the keyword rule (0 = none). */
const commits = (n: number, fixEvery = 0): CommitInfo[] =>
  Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`,
    parent: `parent${i}`,
    message: fixEvery > 0 && i % fixEvery === 0 ? `fix thing ${i}` : `add thing ${i}`,
  }));

describe("selectCandidates", () => {
  it("uses diff-review at exactly 50 commits even when many messages match", () => {
    const sel = selectCandidates(commits(50, 2));
    expect(sel.mode).toBe("diff-review");
    expect(sel.candidates).toHaveLength(50);
  });

  it("uses message mode at 51 commits with 3+ matches", () => {
    const sel = selectCandidates(commits(51, 10)); // matches at 0,10,20,30,40,50
    expect(sel.mode).toBe("message");
    expect(sel.candidates.map((c) => c.sha)).toEqual(
      ["sha0", "sha10", "sha20", "sha30", "sha40", "sha50"],
    );
    expect(sel.candidates[0]!.matchedRules).toEqual(["keyword"]);
  });

  it("uses diff-review at 51 commits with fewer than 3 matches", () => {
    const two = selectCandidates(commits(51, 25)); // matches at 0, 25, 50 => 3
    expect(two.mode).toBe("message");
    const fewer = commits(51).map((c, i) => (i < 2 ? { ...c, message: `fix ${i}` } : c));
    const sel = selectCandidates(fewer);
    expect(sel.mode).toBe("diff-review");
    expect(sel.candidates).toHaveLength(51);
  });

  it("appends diff-review after matched rules and keeps newest-first order", () => {
    const input: CommitInfo[] = [
      { sha: "a", parent: "p", message: 'Revert "Fix x"' },
      { sha: "b", parent: "p", message: "add feature" },
      { sha: "c", parent: "p", message: "Fixes #12" },
    ];
    const sel = selectCandidates(input);
    expect(sel.mode).toBe("diff-review");
    expect(sel.candidates.map((c) => c.sha)).toEqual(["a", "b", "c"]);
    expect(sel.candidates[0]!.matchedRules).toEqual([...matchRules(input[0]!.message), "diff-review"]);
    expect(sel.candidates[1]!.matchedRules).toEqual(["diff-review"]);
    expect(sel.candidates[2]!.matchedRules).toEqual(["keyword", "closing-issue", "diff-review"]);
  });

  it("returns no candidates for an empty history", () => {
    expect(selectCandidates([])).toEqual({ mode: "diff-review", candidates: [] });
  });
});

describe("confirmation loop caps with diff-review Candidates", () => {
  const summarize = async (sha: string) => `summary of ${sha}`;

  it("maxLlmChecks caps checks and counts the rest as unchecked", async () => {
    const { candidates } = selectCandidates(commits(40));
    const llm = createFakeLlm([answer(false, "no")]);
    const out = await confirmCandidates(llm, candidates, { maxLlmChecks: 10 }, summarize);
    expect(llm.calls).toHaveLength(10);
    expect(out.unchecked).toBe(30);
    expect(out.rejected).toHaveLength(10);
  });

  it("limit stops after enough confirmed fixes and counts the rest as unchecked", async () => {
    const { candidates } = selectCandidates(commits(40));
    const llm = createFakeLlm([answer(true, "yes")]);
    const out = await confirmCandidates(llm, candidates, { limit: 3, maxLlmChecks: 50 }, summarize);
    expect(out.confirmed.map((c) => c.sha)).toEqual(["sha0", "sha1", "sha2"]);
    expect(out.confirmed[0]!.matchedRules).toEqual(["diff-review"]);
    expect(out.unchecked).toBe(37);
  });
});
