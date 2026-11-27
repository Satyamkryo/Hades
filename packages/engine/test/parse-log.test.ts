import { describe, expect, it } from "vitest";
import { parseLog } from "../src/ask/parse-log.js";

const MARKER = "HADES-testmarker";

function record(opts: {
  sha?: string;
  parents?: string;
  author?: string;
  date?: string;
  ct?: string;
  body?: string;
  patch?: string;
}): string {
  const {
    sha = "a".repeat(40),
    parents = "",
    author = "Ada",
    date = "2024-01-01T00:00:00+00:00",
    ct = "1704067200",
    body = "subject",
    patch = "",
  } = opts;
  return `\x1e${MARKER}\n${sha}\0${parents}\0${author}\0${date}\0${ct}\0${body}\n\0${patch}`;
}

describe("parseLog", () => {
  it("parses headers, strips the body newline and keeps the patch", () => {
    const [commit] = parseLog(
      record({ body: "fix it", patch: "diff --git a/f b/f\n+new\n" }),
      MARKER,
      4000,
    );
    expect(commit?.sha).toBe("a".repeat(40));
    expect(commit?.message).toBe("fix it");
    expect(commit?.author).toBe("Ada");
    expect(commit?.date).toBe("2024-01-01T00:00:00+00:00");
    expect(commit?.diff).toContain("+new");
    expect(commit?.diffTruncated).toBe(false);
    expect(commit?.committerTime).toBe(1704067200);
  });

  it("does not split on \\x1e or marker text inside a message", () => {
    const commits = parseLog(
      record({ body: "broke \x1e things HADES-testmarker here", patch: "p" }),
      MARKER,
      4000,
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toBe("broke \x1e things HADES-testmarker here");
  });

  it("drops merges and keeps root commits", () => {
    const stdout =
      record({ sha: "b".repeat(40), parents: `${"c".repeat(40)} ${"d".repeat(40)}` }) +
      record({ sha: "e".repeat(40), parents: "" });
    const commits = parseLog(stdout, MARKER, 4000);
    expect(commits.map((c) => c.sha)).toEqual(["e".repeat(40)]);
  });

  it("skips records with a bad SHA or timestamp", () => {
    const stdout =
      record({ sha: "not-a-sha" }) +
      record({ sha: "f".repeat(40), ct: "whenever" }) +
      record({ sha: "1".repeat(40) });
    expect(parseLog(stdout, MARKER, 4000).map((c) => c.sha)).toEqual(["1".repeat(40)]);
  });

  it("cuts the excerpt without splitting a surrogate pair", () => {
    const patch = `xy\u{1F600}zz`;
    const [commit] = parseLog(record({ patch }), MARKER, 3);
    expect(commit?.diff).toBe("xy");
    expect(commit?.diffTruncated).toBe(true);
  });

  it("strips git's record-terminating newline from the patch", () => {
    // Real git appends \n after every record, including --no-patch reads.
    const stdout = `${record({ patch: "a\n" })}\n`;
    const [commit] = parseLog(stdout, MARKER, 4000);
    expect(commit?.diff).toBe("a\n");
    expect(commit?.diffTruncated).toBe(false);

    const [empty] = parseLog(`${record({ patch: "" })}\n`, MARKER, 4000);
    expect(empty?.diff).toBe("");
    expect(empty?.diffTruncated).toBe(false);
  });

  it("marks an empty excerpt of a non-empty patch truncated", () => {
    const [commit] = parseLog(record({ patch: "p" }), MARKER, 0);
    expect(commit?.diff).toBe("");
    expect(commit?.diffTruncated).toBe(true);
  });
});
