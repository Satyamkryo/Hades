import picomatch from "picomatch";

export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/fixtures/**",
];

export const DEFAULT_NON_CODE_PATTERNS: readonly string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "**/docs/**",
  "**/.github/**",
  "**/LICENSE*",
  "**/CHANGELOG*",
  "**/.vscode/**",
  "**/.kiro/**",
];

export const DEPENDENCY_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
];

/** Forward slashes only, no leading "./", so Windows and POSIX paths match alike. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function makeMatcher(patterns: readonly string[]): (path: string) => boolean {
  const isMatch = picomatch([...patterns], { dot: true });
  return (path) => isMatch(normalizePath(path));
}

export function makeTestFileMatcher(extra: readonly string[] = []): (path: string) => boolean {
  return makeMatcher([...DEFAULT_TEST_PATTERNS, ...extra]);
}

export function makeNonCodeMatcher(extra: readonly string[] = []): (path: string) => boolean {
  return makeMatcher([...DEFAULT_NON_CODE_PATTERNS, ...extra]);
}

/** True when the basename (in any folder) is a dependency manifest or lockfile. */
export function isDependencyFile(path: string): boolean {
  const base = normalizePath(path).split("/").pop() ?? "";
  return DEPENDENCY_FILES.includes(base);
}

export interface FileMatchers {
  isTest: (path: string) => boolean;
  isNonCode: (path: string) => boolean;
}

export interface FileSelection {
  /** Neither test nor non-code: the only files that get reverted. */
  source: string[];
  /** Every path that is not a test file (used for the dependency-file check). */
  nonTest: string[];
  skippedTest: string[];
  skippedNonCode: string[];
}

export function selectFiles(paths: readonly string[], m: FileMatchers): FileSelection {
  const sel: FileSelection = { source: [], nonTest: [], skippedTest: [], skippedNonCode: [] };
  for (const p of paths) {
    if (m.isTest(p)) {
      sel.skippedTest.push(p);
      continue;
    }
    sel.nonTest.push(p);
    if (m.isNonCode(p)) sel.skippedNonCode.push(p);
    else sel.source.push(p);
  }
  return sel;
}
