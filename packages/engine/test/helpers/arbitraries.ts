import fc from "fast-check";
import type { CommitSpec } from "./repo.js";

/**
 * fast-check generators for the property tests (task 13.2).
 *
 * Everything here is deterministic ASCII text with LF line endings and lowercase, safe path
 * names, so generated repos behave the same on Windows and POSIX:
 * - every path segment starts with a letter prefix, so it can never be a reserved Windows
 *   device name (`con`, `nul`, `aux`, ...), and has no dots, spaces or uppercase letters;
 * - source files are `.js`, so none of them matches a default test or non-code pattern;
 * - paths always use `/`, the form `makeRepo` and git expect.
 */

/** Path name stem: `n` + 3 to 7 lowercase letters. */
export const safeName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z]{3,7}$/)
  .map((s) => `n${s}`);

/** One line of deterministic code-like text. `index` keeps every line of a file unique. */
function codeLine(index: number, value: number): string {
  return `export const v${index} = ${value};`;
}

/** File body: 4 to 12 unique lines, LF endings, trailing newline. */
export const fileLines: fc.Arbitrary<string[]> = fc
  .array(fc.integer({ min: 0, max: 9999 }), { minLength: 4, maxLength: 12 })
  .map((values) => values.map((v, i) => codeLine(i, v)));

export function joinLines(lines: readonly string[]): string {
  return lines.join("\n") + "\n";
}

/** A tree of files: relative `/` path -> text content. */
export type FileTree = Record<string, string>;

/** Source file paths only (`src/<name>.js` or `src/<dir>/<name>.js`), all distinct. */
export const sourcePath: fc.Arbitrary<string> = fc
  .tuple(fc.boolean(), safeName, safeName)
  .map(([nested, dir, name]) => (nested ? `src/${dir}/${name}.js` : `src/${name}.js`));

/** A file tree of 1 to `maxFiles` distinct source files with generated content. */
export function fileTree(maxFiles = 4): fc.Arbitrary<FileTree> {
  return fc
    .uniqueArray(fc.tuple(sourcePath, fileLines), {
      minLength: 1,
      maxLength: maxFiles,
      selector: ([p]) => p,
    })
    .map((entries) => Object.fromEntries(entries.map(([p, lines]) => [p, joinLines(lines)])));
}

/** What a mixed fix commit touched, by kind. All paths exist in the base commit. */
export interface MixedFixScenario {
  /** Commits to give to `makeRepo`: base, fix, then optionally a later commit. */
  commits: CommitSpec[];
  /** Index of the fix commit in `commits` (always 1). */
  fixIndex: number;
  sourcePaths: string[];
  testPaths: string[];
  nonCodePaths: string[];
  /** Source path -> content before the fix. */
  baseContent: FileTree;
  /** Source path -> content after the fix. */
  fixedContent: FileTree;
  /** Whether a later commit exists and whether it conflicts with the fix. */
  later: "none" | "clean" | "conflicting";
}

interface Planned {
  source: string[];
  test: string[];
  nonCode: string[];
  lines: string[][];
  fixLine: number[];
  fixValue: number[];
  laterKind: "none" | "clean" | "conflicting";
  laterValue: number;
  word: string;
}

/**
 * A fix commit that touches 1-3 source files plus 0-2 test files and 0-2 non-code files,
 * optionally followed by a later commit that rewrites the fixed lines (conflicting) or only
 * adds new files (clean). The fix changes exactly one line of each source file, so the
 * expected reverse-apply result is known.
 */
export const mixedFixScenario: fc.Arbitrary<MixedFixScenario> = fc
  .tuple(
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 0, max: 2 }),
    fc.integer({ min: 0, max: 2 }),
  )
  .chain(([nSource, nTest, nNonCode]) =>
    fc.record({
      names: fc.uniqueArray(safeName, {
        minLength: nSource + nTest + nNonCode,
        maxLength: nSource + nTest + nNonCode,
      }),
      lines: fc.array(fileLines, { minLength: nSource, maxLength: nSource }),
      fixLineSeed: fc.array(fc.nat(), { minLength: nSource, maxLength: nSource }),
      fixValue: fc.array(fc.integer({ min: 10000, max: 19999 }), {
        minLength: nSource,
        maxLength: nSource,
      }),
      laterKind: fc.constantFrom<Planned["laterKind"]>("none", "clean", "conflicting"),
      laterValue: fc.integer({ min: 20000, max: 29999 }),
      testStyle: fc.array(fc.constantFrom("test", "spec", "dir"), {
        minLength: nTest,
        maxLength: nTest,
      }),
      nonCodeStyle: fc.array(fc.constantFrom("docs", "md", "txt"), {
        minLength: nNonCode,
        maxLength: nNonCode,
      }),
      word: fc.constantFrom("crash", "timeout", "overflow", "null", "retry"),
      nSource: fc.constant(nSource),
      nTest: fc.constant(nTest),
    }),
  )
  .map((r): MixedFixScenario => {
    const source = r.names.slice(0, r.nSource).map((n) => `src/${n}.js`);
    const testNames = r.names.slice(r.nSource, r.nSource + r.nTest);
    const nonCodeNames = r.names.slice(r.nSource + r.nTest);
    const test = testNames.map((n, i) => {
      const style = r.testStyle[i];
      return style === "test" ? `src/${n}.test.js` : style === "spec" ? `src/${n}.spec.js` : `test/${n}.js`;
    });
    const nonCode = nonCodeNames.map((n, i) => {
      const style = r.nonCodeStyle[i];
      return style === "docs" ? `docs/${n}.html` : style === "md" ? `${n}.md` : `${n}.txt`;
    });

    const planned: Planned = {
      source,
      test,
      nonCode,
      lines: r.lines,
      fixLine: r.fixLineSeed.map((seed, i) => seed % (r.lines[i]?.length ?? 1)),
      fixValue: r.fixValue,
      laterKind: r.laterKind,
      laterValue: r.laterValue,
      word: r.word,
    };
    return buildScenario(planned);
  });

function buildScenario(p: Planned): MixedFixScenario {
  const baseContent: FileTree = {};
  const fixedContent: FileTree = {};
  const baseFiles: Record<string, string> = {};
  const fixFiles: Record<string, string> = {};
  const laterFiles: Record<string, string> = {};

  p.source.forEach((path, i) => {
    const lines = p.lines[i] ?? [];
    const k = p.fixLine[i] ?? 0;
    const fixedLines = lines.map((l, idx) => (idx === k ? codeLine(idx, p.fixValue[i] ?? 0) : l));
    baseContent[path] = joinLines(lines);
    fixedContent[path] = joinLines(fixedLines);
    baseFiles[path] = baseContent[path];
    fixFiles[path] = fixedContent[path];

    if (p.laterKind === "conflicting") {
      // Rewrites the very line the fix changed, so `git apply -R --3way` must conflict.
      laterFiles[path] = joinLines(fixedLines.map((l, idx) => (idx === k ? codeLine(idx, p.laterValue) : l)));
    } else if (p.laterKind === "clean") {
      // Touches nothing the fix changed: a new file, so reverse-apply is guaranteed clean.
      laterFiles[`src/later${i}.js`] = `export const later${i} = ${p.laterValue};\n`;
    }
  });

  p.test.forEach((path, i) => {
    baseFiles[path] = `// test ${i}\nexport const t = 1;\n`;
    fixFiles[path] = `// test ${i}\nexport const t = 2;\n`;
  });
  p.nonCode.forEach((path, i) => {
    baseFiles[path] = `notes ${i} before\n`;
    fixFiles[path] = `notes ${i} after fix of ${p.word}\n`;
  });

  const commits: CommitSpec[] = [
    { message: "initial commit", files: baseFiles },
    { message: `fix: ${p.word} bug`, files: fixFiles },
  ];
  if (p.laterKind !== "none") {
    commits.push({ message: "refactor: later change", files: laterFiles });
  }

  return {
    commits,
    fixIndex: 1,
    sourcePaths: p.source,
    testPaths: p.test,
    nonCodePaths: p.nonCode,
    baseContent,
    fixedContent,
    later: p.laterKind,
  };
}

/** A scenario with a conflicting later commit (the fixed lines are rewritten). */
export const conflictingScenario: fc.Arbitrary<MixedFixScenario> = mixedFixScenario.filter(
  (s) => s.later === "conflicting",
);

/** A scenario with no later commit, so reverse-apply always succeeds. */
export const cleanScenario: fc.Arbitrary<MixedFixScenario> = mixedFixScenario.filter(
  (s) => s.later === "none",
);

/** Extra patterns: a glob plus a source-looking file path that the glob matches. */
export interface ExtraPatternCase {
  /** Value for `extraTestPatterns` or `extraNonCodePatterns`. */
  pattern: string;
  /** A `.js` path under a generated folder that `pattern` matches. */
  matchingPath: string;
  /** A `.js` path under `src/` that `pattern` does not match. */
  otherPath: string;
}

export const extraPatternCase: fc.Arbitrary<ExtraPatternCase> = fc
  .tuple(safeName, safeName, safeName, fc.constantFrom("dir", "ext"))
  .filter(([dir, a, b]) => a !== b && dir !== "src")
  .map(([dir, a, b, style]) =>
    style === "dir"
      ? { pattern: `**/${dir}/**`, matchingPath: `${dir}/${a}.js`, otherPath: `src/${b}.js` }
      : { pattern: `**/*.${dir}.js`, matchingPath: `src/${a}.${dir}.js`, otherPath: `src/${b}.js` },
  );

/** Path separators variants of the same path, for matcher agreement checks. */
export const withBackslashes = (p: string): string => p.replace(/\//g, "\\");
