import { describe, expect, it } from "vitest";
import { parseBlame } from "../src/ask/parse-blame.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);

function group(sha: string, orig: number, final: number, size: number): string {
  return (
    `${sha} ${orig} ${final} ${size}\n` +
    `author Tester\n` +
    `author-mail <t@example.invalid>\n` +
    `filename f.c\n` +
    `\tcontent line\n`.repeat(size)
  );
}

describe("parseBlame", () => {
  it("merges consecutive lines with the same SHA", () => {
    const stdout = group(A, 1, 1, 3) + group(B, 4, 4, 1) + group(A, 5, 5, 2);
    expect(parseBlame(stdout)).toEqual([
      { start: 1, end: 3, sha: A },
      { start: 4, end: 4, sha: B },
      { start: 5, end: 6, sha: A },
    ]);
  });

  it("drops the all-zero SHA", () => {
    const stdout = group(A, 1, 1, 1) + group(Z, 2, 2, 1) + group(A, 3, 3, 1);
    expect(parseBlame(stdout)).toEqual([
      { start: 1, end: 1, sha: A },
      { start: 3, end: 3, sha: A },
    ]);
  });

  it("ignores non-header lines", () => {
    expect(parseBlame("author Nobody\nfilename f.c\n")).toEqual([]);
    expect(parseBlame("")).toEqual([]);
  });
});
