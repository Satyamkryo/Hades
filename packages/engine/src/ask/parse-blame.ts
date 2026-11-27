import type { BlameRange } from "./types.js";

const ZERO_SHA = "0".repeat(40);
// Porcelain group header: `<sha> <orig-line> <final-line> [<group-size>]`.
// Boundary (`^sha`) and uncommitted (`0{40}`) lines never match or are dropped:
// blaming HEAD cannot produce them, so seeing one means corrupt input.
const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Parse `git blame --porcelain` into merged `{ start, end, sha }` ranges over
 * final line numbers. Only header lines are read; the all-zero SHA is dropped
 * defensively.
 */
export function parseBlame(stdout: string): BlameRange[] {
  const byLine = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("\t")) {
      continue;
    }
    const match = HEADER.exec(line.trim());
    if (match === null) {
      continue;
    }
    const [, sha, , finalStart, groupSize] = match as unknown as [
      string,
      string,
      string,
      string,
      string?,
    ];
    if (sha === ZERO_SHA) {
      continue;
    }
    const start = Number.parseInt(finalStart ?? "0", 10);
    const size = Number.parseInt(groupSize ?? "1", 10);
    if (!Number.isFinite(start) || !Number.isFinite(size) || size < 1) {
      continue;
    }
    for (let lineNo = start; lineNo < start + size; lineNo += 1) {
      byLine.set(lineNo, sha as string);
    }
  }
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const ranges: BlameRange[] = [];
  for (const lineNo of lines) {
    const sha = byLine.get(lineNo) as string;
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last.sha === sha && last.end + 1 === lineNo) {
      last.end = lineNo;
    } else {
      ranges.push({ start: lineNo, end: lineNo, sha });
    }
  }
  return ranges;
}
