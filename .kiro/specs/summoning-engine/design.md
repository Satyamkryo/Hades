# Design: Summoning Engine

## Overview

`packages/engine` exposes one public entry point, `resurrect(repoPath, options?, deps?)`,
which returns an `UnderworldReport`. The MCP tool `resurrect(repo, limit?)` will later wrap it
one-to-one. The engine is plain TypeScript with no MCP, VS Code or GitHub imports.
`packages/engine/scripts/summon.ts` runs it on a real repo from the command line.

Sections and steps marked **(optional)** are built after the real-repo check passes. Until
then the code paths they describe do not exist, and the report fields they fill have their
neutral value (`staleCleaned: 0`, `workspace: false`, `runs: 1`).

## Architecture

The run, in order:

1. **Validate** options, the Repo path and the git version; read `HEAD` as the Base commit.
2. **(optional) Clean stale worktrees** left by crashed Hades runs.
3. **Scan** the newest `maxCommits` commits and **select Candidates**: message rules, or
   diff-review mode when the history is small or few messages match.
4. **Detect the test suite** from `HEAD:package.json` (skipped when the caller set
   `testCommand`). No test suite means status `no-tests` for the rest of the run.
5. If there are no Candidates, return an empty report (status `ok` or `no-tests`). No LLM
   env, worktree or tests needed.
6. **Check the LLM env** (fail fast if a variable is missing, before any worktree).
7. **Plan dependencies** once for the run: link, install or none (plus, optionally, the
   workspace warning). Skipped for `no-tests`.
8. **Baseline**: one worktree at HEAD with no changes, run tests. If they fail, return a
   `baseline-failed` report with hints. This runs before the LLM, so a broken test suite
   costs no LLM calls. Skipped for `no-tests`.
9. **Confirm** Candidates newest first with the LLM, stopping at `limit` confirmed fixes or
   `maxLlmChecks` calls. Auth errors and an unreachable endpoint stop the run.
10. **Summon** each Confirmed fix one at a time: select files, create the worktree, set up
    dependencies, reverse-apply, run tests, label, clean up (always). For `no-tests`,
    instead put each Confirmed fix into `unguarded`; no worktree is created.
11. **Verify** every reported SHA exists, redact options, and return the report.

```
resurrect()
  ├─ config ─────────── zod options
  ├─ repo/validate ──── git rev-parse, git --version
  ├─ summon/stale ───── (optional) git worktree list --porcelain, pid check
  ├─ history/scan ───── git log
  ├─ history/candidates (pure) matchRules + selectCandidates (diff-review mode)
  ├─ repo/test-suite ── git show HEAD:package.json
  ├─ llm/env ────────── read HADES_LLM_*
  ├─ summon/deps-plan ─ link / install / none (+ optional workspace detection)
  ├─ summon/baseline ── worktree + deps + process, hints on failure
  ├─ llm/confirm ────── llm/client (fetch) + zod
  ├─ summon/summon-one
  │     ├─ history/fix-diff ──── git diff
  │     ├─ classify/files (pure) test, non-code, dependency-file matchers
  │     ├─ summon/worktree ───── git worktree add, lock / unlock, remove, prune
  │     ├─ summon/deps ───────── junction/symlink, installCommand
  │     ├─ summon/apply ──────── per the spike result
  │     └─ summon/process ────── spawn, timeout, kill tree
  └─ report/verify, report/redact

scripts/summon.ts ── CLI: parse args, resurrect() with the real LLM client,
                     print summary, write JSON report
```

## Monorepo layout (Requirement 1)

```
package.json             private, type: module, workspaces: ["packages/*"], engines.node >=20
                         scripts: build (tsc -b packages/engine),
                                  test (npm test -w @hades/engine),
                                  summon (npm run summon -w @hades/engine --)
tsconfig.base.json       strict, target ES2022, module/moduleResolution NodeNext,
                         declaration, sourceMap, noUncheckedIndexedAccess
.gitignore               node_modules/, dist/, coverage/, .env, .env.*  (not .kiro/)
packages/engine/
  package.json           name @hades/engine, type: module, main/types -> dist
                         scripts: build (tsc), test (vitest run), summon (tsx scripts/summon.ts)
  tsconfig.json          extends ../../tsconfig.base.json, rootDir src, outDir dist
  vitest.config.ts       testTimeout raised for git-backed property tests (60s)
  README.md              usage, options, and the trust warning (Requirement 1.8)
  src/ ...               see Components
  scripts/summon.ts      real-repo check (Requirement 14)
  test/ ...              see Testing strategy
```

Dependencies: `zod`, `picomatch`. Dev: `typescript`, `vitest`, `fast-check`, `@types/node`,
`@types/picomatch`, `tsx` (runs `scripts/summon.ts` without a separate build step). Git is
called directly with `node:child_process` `execFile` (no shell, arguments as an array), so
user-controlled strings like file paths are never parsed by a shell. `simple-git` is not
needed.

**README trust warning:** summoning runs the Repo's own test scripts, and `installCommand`
runs its install scripts (including package lifecycle scripts). Only run Hades on repos you
trust.

## Spike result: `git apply -R --3way`

**Windows (task 1.4): decision is `git apply -R --3way`. The fallback is not needed.**

- `git --version`: `git version 2.45.1.windows.1` (Node v24.4.1, npm 11.4.2, Windows).
- Test: `packages/engine/test/spike/apply-3way.test.ts`, 5 tests, all passing.
- `-R --3way` with the patch from `git diff --binary --full-index F^ F`, applied in a
  `git worktree add --detach` at L:
  - Clean case (L edited lines 8 and 12 inside the patch context, fix on line 10): exit 0,
    no unmerged paths, file content as expected.
  - Conflict case (L rewrote the fixed line): non-zero exit, stderr
    `Applied patch to 'src/a.js' with conflicts.`, and `src/a.js` listed by
    `git diff --name-only --diff-filter=U`.
  - Afterwards `git status` works in the worktree and `git worktree remove --force` succeeds.
- Fallback (`git diff --binary --full-index F F^` applied with `git apply --3way`) gave the
  same results in both cases. It stays documented as the alternative.
- Finding: an edit on a line directly adjacent to the fixed line is a true conflict in git's
  three-way merge (a first fixture with lines 9 and 11 changed conflicted). That is expected
  and maps to `lost` / `revert did not apply`.
- `fix-diff.ts` and `apply.ts` sections are unchanged because the fallback was not chosen.

*A Linux run is a separate optional task later, on the Linux VM or in GitHub Actions
(`ubuntu-latest`).*

Recorded per platform: the exact `git --version`, whether `-R` with `--3way` is accepted,
the exit code on a clean apply, the exit code and unmerged paths on a conflict, and whether
the worktree can still be used and removed afterwards.

- If `-R --3way` works as expected: `summon/apply` uses it as written below.
- If it is unsupported or unreliable: `fixPatch` builds the reverse patch directly with
  `git diff <sha> <sha>^` (fix → parent), and `summon/apply` runs `git apply --3way` without
  `-R`. Everything else in this design stays the same.

## Components and Interfaces

All paths are under `packages/engine/src/`. One responsibility per file.

### `config.ts` (Requirement 13)

```ts
export interface ResurrectOptions {
  testCommand?: string;           // default "npm test"
  timeoutMs?: number;             // default 120_000
  limit?: number;                 // default undefined (no limit)
  maxCommits?: number;            // default 500
  maxLlmChecks?: number;          // default 50
  extraTestPatterns?: string[];   // default []
  extraNonCodePatterns?: string[];// default []
  installCommand?: string;        // default undefined
  installTimeoutMs?: number;      // default 600_000
  alwaysInstall?: boolean;        // default false
  excerptChars?: number;          // default 4000
  rerunOnFail?: number;           // (optional) default 0, integer 0..3
}
export interface ResurrectDeps {
  llm?: LlmClient;                // injected fake in tests
  signal?: AbortSignal;           // (optional) wired to SIGINT/SIGTERM by packages/mcp-server
}
export function resolveOptions(input?: ResurrectOptions): ResolvedOptions;
```

Validated with a zod schema (positive integers, non-empty strings, `alwaysInstall: true`
requires `installCommand`, and, once reruns exist, `rerunOnFail` 0–3). Invalid options throw
`HadesConfigError` before any git command runs. No file-based config.

### `errors.ts`

`HadesConfigError` (bad options, bad repo, LLM config or auth problems, LLM unreachable),
`GitError` (internal; usually turned into a `lost` reason), and **(optional)**
`HadesAbortError` (signal aborted).

### `git/exec.ts`

`runGit(cwd, args, { allowFail? }) -> { stdout, stderr, code }`. Uses `execFile("git", args)`
with `maxBuffer` 64 MB and an env that adds `GIT_TERMINAL_PROMPT=0` (never block on a
credential prompt) and `LC_ALL=C` (stable English output for parsing). Throws `GitError`
(command, code, stderr) unless `allowFail`. (Optional: a `signal` parameter passed to
`execFile`.)

### `repo/validate.ts`

- `git --version`; require git >= 2.30.
- Repo path must be absolute and `git rev-parse --show-toplevel` must equal it (after
  `realpath` normalisation), so callers cannot point at a subfolder by mistake.
- Base commit: `git rev-parse --verify HEAD^{commit}`. An empty repo (no HEAD) returns an
  empty report.

Uncommitted changes in the Real working tree are ignored on purpose: summoning runs at the
committed HEAD.

### `repo/test-suite.ts` (Requirement 9)

```ts
function hasTestSuite(repo: string, baseSha: string): Promise<boolean>;
```

- Called only when the caller's raw options have no `testCommand` (checked before
  `resolveOptions` fills the default), so an explicit `testCommand` always runs as usual.
- Reads `git show <baseSha>:package.json` (the committed file, matching the Base commit,
  not the possibly edited working copy). A missing file means no test suite.
- `JSON.parse`; if it fails, the engine assumes a test suite exists and lets the baseline
  report the problem, so a broken `package.json` is never silently treated as "no tests".
- No test suite when `scripts.test` is missing, not a string, empty after trimming, or
  contains `no test specified` (npm's default `echo "Error: no test specified" && exit 1`).

### `history/scan.ts` (Requirement 2.1, 2.4)

```
git log -n <maxCommits> --format=%H%x00%P%x00%B%x1e HEAD
```

`%x00` separates SHA, parents and the raw body; `%x1e` (record separator) ends each commit.
Each record is trimmed (git puts a newline before every record after the first) before it is
split on `%x00`. Commits whose parent list does not have exactly one SHA (root or merge) are
dropped. Output order is newest first.

```ts
interface CommitInfo { sha: string; parent: string; message: string }
```

### `history/candidates.ts` (Requirement 2.2, 2.3, 2.7) — pure

```ts
type CandidateRule = "keyword" | "closing-issue" | "revert";
function matchRules(message: string): CandidateRule[];
```

- `keyword`: `/\b(fix|fixes|fixed|fixing|bugfix|bug|crash|hotfix|revert)\b/i`
- `closing-issue`: `/\b(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s+#\d+\b/i`
- `revert`: subject matches `/^Revert "/` or body matches `/This reverts commit [0-9a-f]{7,40}/`

There is no rule for a bare `#\d+`. In message mode, a commit is a Candidate when
`matchRules` is non-empty. (`fix #12` matches both `keyword` and `closing-issue`; both are
recorded.)

**Candidate selection (Requirement 2.8, 2.9), task 8.0:**

```ts
type CandidateRule = "keyword" | "closing-issue" | "revert" | "diff-review";
const DIFF_REVIEW_MAX_HISTORY = 50;   // at most this many scanned commits -> diff-review
const DIFF_REVIEW_MIN_MATCHES = 3;    // fewer message matches than this -> diff-review
function selectCandidates(commits: CommitInfo[]): { mode: "message" | "diff-review"; candidates: Candidate[] };
```

- Input is the `scanCommits` output (newest first, root and merge commits already dropped).
- `matched = commits` with non-empty `matchRules`.
- If `commits.length <= 50` or `matched.length < 3`: mode `diff-review`, and every commit
  is a Candidate with `matchedRules = [...matchRules(message), "diff-review"]`, newest first.
- Otherwise: mode `message`, Candidates are `matched`, unchanged from task 4.1.
- The confirmation loop (task 5.5) is unchanged: it already sends the message plus
  `diffSummary` and applies `limit` and `maxLlmChecks`. With 500 scanned commits in
  diff-review mode, at most `maxLlmChecks` (default 50) of them are checked and the rest
  count as `unchecked`.
- `CandidateRule` is currently declared in both `history/candidates.ts` and
  `report/types.ts`; `diff-review` is added to both (or the first re-exports the second, so
  there is one declaration).

### `classify/files.ts` (Requirement 4) — pure

```ts
const DEFAULT_TEST_PATTERNS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**",
  "**/__mocks__/**", "**/test/**", "**/tests/**", "**/fixtures/**"];
const DEFAULT_NON_CODE_PATTERNS = ["**/*.md", "**/*.mdx", "**/*.txt", "**/docs/**",
  "**/.github/**", "**/LICENSE*", "**/CHANGELOG*", "**/.vscode/**", "**/.kiro/**"];
const DEPENDENCY_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json",
  "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];

function makeTestFileMatcher(extra: string[]): (path: string) => boolean;
function makeNonCodeMatcher(extra: string[]): (path: string) => boolean;
function isDependencyFile(path: string): boolean;   // basename in DEPENDENCY_FILES
function selectFiles(paths: string[], m): {
  source: string[];      // neither test nor non-code: the files to revert
  nonTest: string[];     // used for the dependency-file check
  skippedTest: string[];
  skippedNonCode: string[];
};
```

Uses `picomatch` with `{ dot: true }`. Paths are normalised to forward slashes and matched
relative to the Repo root. `**/test/**` also matches a root-level `test/` folder.

### `history/fix-diff.ts` (Requirement 4, 5.3)

- `changedFiles(repo, sha)`: `git diff --name-only --no-renames -z <sha>^ <sha>`. `-z`
  gives NUL-separated raw paths (no quoting of spaces or unicode). `--no-renames` turns a
  rename into a delete plus an add, so each path is classified on its own and a rename from
  `src/` to `test/` cannot bring a test file into the revert.
- `fixPatch(repo, sha, paths)`: one call per Source path,
  `git diff --binary --full-index --no-renames <sha>^ <sha> -- ":(literal)<path>"`, joined
  into one patch. `:(literal)` stops git from treating `*` or `?` in a filename as a glob.
  `--binary --full-index` keeps binary files and full blob IDs, which `--3way` needs.
  (If the spike requires the fallback, the commit order becomes `<sha> <sha>^`.)
- `diffSummary(repo, sha, maxChars = 6000)` for the LLM: `--stat` plus the start of the patch,
  cut to `maxChars`.

If the parent object is missing (shallow clone), the call fails and the fix is labelled
`lost` with reason `parent commit not available`.

### `llm/env.ts`, `llm/client.ts`, `llm/confirm.ts` (Requirement 3)

```ts
interface LlmClient { complete(system: string, user: string): Promise<string> }
class LlmHttpError extends Error { status: number }
class LlmNetworkError extends Error {}
function readLlmEnv(env = process.env): { baseUrl; apiKey; model };  // HadesConfigError naming missing vars
function createOpenAiCompatibleClient(cfg, { timeoutMs = 30_000 }): LlmClient;
```

- `POST <baseUrl without trailing slash>/chat/completions` with
  `{ model, temperature: 0, messages }` and `Authorization: Bearer <key>`, using Node's
  built-in `fetch` with a 30 s `AbortSignal.timeout`. `response_format` is not sent, because
  not every compatible server accepts it; the prompt asks for JSON only.
- Non-2xx responses throw `LlmHttpError` with the status and the body trimmed to 500 chars.
  Fetch failures and timeouts throw `LlmNetworkError`. A `redact()` helper removes the key
  from any string before it goes into an error or report; the `Authorization` header is
  never included.
- System prompt: answer with exactly `{"isBugFix": boolean, "reason": string}`; a commit that
  reverts a bug fix (for example `Revert "Fix ..."`) is not a bug fix and must be answered
  `isBugFix: false`.
- Reply parsing: strip an optional Markdown code fence, `JSON.parse`, then
  `z.object({ isBugFix: z.boolean(), reason: z.string().min(1).max(500) })`.

`confirmFix` returns one of:

```ts
| { kind: "confirmed"; reason: string }
| { kind: "rejected"; reason: string }                       // isBugFix: false
| { kind: "error"; reason: string; transport: boolean }      // transport = HTTP or network
```

`invalid LLM response` is `transport: false`. `LlmHttpError` with status 401, 403 or 404 is
not caught here; it propagates as `HadesConfigError("LLM endpoint returned <status>")`.

**Confirmation loop (2.5, 2.6, 3.6–3.9):** iterate Candidates newest first; stop when
`confirmed.length === limit` or `checks === maxLlmChecks`. Every call counts as a check,
including errors. After each result: `rejected` goes to `report.rejected`, `error` goes to
`report.llmErrors`. If checks 1, 2 and 3 of the run are all `transport: true` errors, throw
`HadesConfigError("LLM unreachable")`. Every Candidate not reached is counted `unchecked`.

`resurrect()` accepts `deps.llm` so tests inject a fake; the real client is only built (and
env only read) when Candidates exist and no fake is given.

### `summon/worktree.ts` (Requirement 5.1, 5.5, 5.8)

The lock is required. It is a separate command because `git worktree add --reason` needs a
newer git than the 2.30 minimum, while `git worktree lock --reason` is available in 2.30.

`createWorktree(repo, base)`:

1. `dir = fs.mkdtemp(join(os.tmpdir(), "hades-summon-"))`.
2. `git -C <repo> worktree add --detach <dir> <base>`. `--detach` means no branch is created
   or moved. This writes metadata only under the Repo's `.git/worktrees/`, never to the Real
   working tree, its index, HEAD or refs.
3. `git -C <repo> worktree lock --reason "hades pid=<process.pid>" <dir>`. The lock stops
   `git worktree prune` (by the user or another tool) from removing the metadata mid-run, and
   the reason lets stale cleanup identify the owner. Between steps 2 and 3 the worktree is
   unlocked, but prune only removes worktrees whose folder is missing, so this gap is safe.
4. If step 2 or 3 fails (or anything else throws inside `createWorktree`), it calls
   `removeWorktree(repo, dir)` (same safety gate) and rethrows the original error. Callers
   turn that into `lost` for the fix, or a baseline failure.

`removeWorktree(repo, dir, linkPath?)`:

1. Note whether `dir` exists at the start (`existedAtStart`).
2. Remove the dependency link, if any (see deps).
3. `git -C <repo> worktree unlock <dir>` (allowFail: it may not be locked).
4. `git -C <repo> worktree remove --force <dir>` (allowFail).
5. If the folder still exists, run the safety gate, then
   `fs.rm(dir, { recursive: true, force: true })`.
6. Run `git -C <repo> worktree prune` if step 5 ran or `existedAtStart` was false. In both
   cases git may still hold metadata for a folder that is gone.

Safety gate: step 5 runs only if step 2 confirmed nothing remains at the link path (`lstat`
throws `ENOENT`). If the link could not be removed, the recursive delete is skipped, a
`cleanupWarning` is recorded, and the folder is left in the temp dir rather than risk
deleting the Repo's real `node_modules` through the link.

Every flow that creates a worktree calls `removeWorktree` from a `finally` block.

### `summon/deps-plan.ts` and `summon/deps.ts` (Requirement 6)

`planDeps(repo, opts)` runs once per run:

```ts
type DepsPlan = { method: "link" | "install" | "none"; workspace: boolean; warning?: string };
```

| Condition (first match wins) | method | warning |
| --- | --- | --- |
| `alwaysInstall` | install | |
| (optional) workspace and `installCommand` | install | |
| (optional) workspace, no `installCommand`, `node_modules` exists | link | workspace warning text |
| `node_modules` exists | link | |
| `installCommand` | install | |
| otherwise | none | |

**(optional) Workspace detection:** root `package.json` parses and has a `workspaces` field;
or `pnpm-workspace.yaml` exists; or an entry in `<repo>/node_modules` (top level and one level
inside `@scope/` folders) is a symlink whose `realpath` is inside the Repo. The workspace
warning text is exactly the one in Requirement 6.4 and goes into `report.warnings` once.
Until this exists, `workspace` is always `false`.

`setupDeps(repo, worktree, plan, opts)`:

- `link`: `fs.symlink(path.resolve(repo, "node_modules"), join(wt, "node_modules"),
  platform === "win32" ? "junction" : "dir")`. Junctions need an absolute target and no admin
  rights. If it throws and `installCommand` is set, fall back to install; otherwise fail.
- `install`: `runCommand(installCommand, wt, { timeoutMs: installTimeoutMs })`. Non-zero exit
  or timeout fails.
- `none`: nothing.
- Failure result: `lost`, reason `dependency setup failed`, with the output excerpt.

`removeLink(linkPath)`: `lstat`; if it is a symlink/junction, `fs.unlink`, falling back to
`fs.rmdir` on `EPERM`/`EISDIR` (on Windows `rmdir` removes a junction itself, not its
target). Never a recursive delete on the link.

### `summon/apply.ts` (Requirement 5.3, 5.4)

`reverseApply(worktree, patch)`: write the patch to a temp file outside the worktree, run
`git -C <worktree> apply -R --3way --whitespace=nowarn <patchFile>`. `--3way` falls back to a
three-way merge using the blob IDs in the patch when the context has drifted since the fix.
Success means exit code 0 **and** `git -C <worktree> diff --name-only --diff-filter=U` is
empty (no unmerged paths). Otherwise: `lost`, reason `revert did not apply`, with the apply
stderr as the excerpt. The exact command is confirmed or replaced by the spike.

### `summon/process.ts` (Requirement 8)

```ts
interface RunResult { code: number | null; timedOut: boolean; spawnError?: string;
  output: string; durationMs: number }
function runCommand(cmd: string, cwd: string,
  opts: { timeoutMs: number; excerptChars: number }): Promise<RunResult>;
```

- `spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32" })`.
  A shell is needed because `testCommand` is a command line such as `npm test` (and `npm` is
  `npm.cmd` on Windows). The command comes from the trusted caller's options, never from the
  Repo or LLM. stdin is ignored so a test runner that waits for input cannot hang on it.
- Child env: `process.env` minus `HADES_LLM_API_KEY`, plus `CI=true` (so Vitest/Jest run once
  instead of entering watch mode and hanging until the timeout).
- stdout and stderr go into one rolling buffer that keeps only the last `excerptChars`
  characters, so memory stays bounded for noisy test suites.
- On timeout, kill the whole process tree: POSIX `process.kill(-pid, "SIGKILL")` (the child is
  a process-group leader because of `detached`); Windows `taskkill /pid <pid> /T /F`. The
  promise resolves after the child's `close` event, or 5 s after the kill at most.
- The engine never registers `process.on("SIGINT")` or similar.

### `summon/baseline.ts` (Requirement 8.5, 8.6)

Worktree at Base, `setupDeps`, `runCommand(testCommand)`, cleanup in `finally`. Pass means
exit 0 without timeout. Otherwise returns `{ passed: false, reason, excerpt }`, where
`reason` is the failure (`tests failed`, `timeout`, `dependency setup failed`,
`worktree setup failed`) followed by any hints from `baselineHints(repo)`:

| Check | Hint |
| --- | --- |
| `.gitmodules` exists | repo uses submodules, which are not initialised in the summoning worktree |
| `.gitattributes` contains `filter=lfs` | repo uses Git LFS; LFS files may be pointers in the summoning worktree |
| `git ls-files --others --ignored --exclude-standard -- ".env*"` is non-empty | repo has gitignored .env files, which are not copied into the summoning worktree |

Hints are joined with `; `. The baseline never reruns.

### `summon/summon-one.ts` (Requirements 4, 5, 10)

```
files        = changedFiles(sha)                 -> fail: lost "parent commit not available"
sel          = selectFiles(files)
if sel.source is empty                           -> lost "no source files to revert"
if plan.method == "link" and changesDependencies(repo, sha, sel.nonTest)
                                                 -> lost "fix changes dependencies"
patch        = fixPatch(sha, sel.source)
wt           = createWorktree(base)              -> fail: lost "internal error: worktree ..."
try
  setupDeps  -> fail: lost "dependency setup failed"
  apply      -> fail: lost "revert did not apply"
  run tests  -> spawnError: lost "test command failed to start"
                timedOut:   lost "timeout"
                code 0:     escaped
                code != 0:  buried   (optional: reruns, see below)
finally removeWorktree(wt)
```

- The two early `lost` checks happen before any worktree is created.
- `changesDependencies` (in `history/dependency-change.ts`, below) is only called when the
  plan is `link`, so install and none plans never pay for the extra `git show` calls.
- Any other unexpected exception becomes `lost` with reason `internal error: <message>`, so
  one bad commit never aborts the whole run.
- `filesReverted` is exactly `sel.source`.
- **(optional) Reruns:** on a non-zero exit, rerun up to `rerunOnFail` times. If any rerun
  exits 0, the label is `lost` with reason `flaky tests`; otherwise `buried`. A rerun that
  times out counts as a failed rerun. The excerpt is from the first failing run, since that
  output shows what broke. `runs` records 1 + reruns performed.

### `history/dependency-change.ts` (Requirement 4.6–4.8)

```ts
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies",
  "optionalDependencies", "bundleDependencies"] as const;
function changesDependencies(repo: string, sha: string, nonTestPaths: string[]): Promise<boolean>;
```

For each path where `isDependencyFile(path)` is true (stops at the first `true`):

- Basename is a lockfile (anything in `DEPENDENCY_FILES` except `package.json`): `true`.
- Basename is `package.json`: read both sides with
  `git show <sha>^:<path>` and `git show <sha>:<path>` (`allowFail`; paths are tree paths,
  passed as one `execFile` argument, so no pathspec or shell parsing applies).
  - Either side missing (file added or deleted by the fix), not valid JSON, or not a plain
    JSON object: `true`.
  - Otherwise compare each field in `DEPENDENCY_FIELDS` with `util.isDeepStrictEqual`
    (key order does not matter; a missing field equals a missing field). Any difference:
    `true`.
- If no path returned `true`: `false`, and a changed `package.json` is reverted like any
  other Source file.

`classify/files.ts` stays pure and unchanged: `isDependencyFile` still only names the
candidate files. The git-backed comparison lives here, next to `fix-diff.ts`.

Trade-off: a `package.json` change to `scripts` (including `scripts.test`) is reverted with
the fix. That is intended; only dependency fields make the linked `node_modules` wrong.

### `report/verify.ts`, `report/redact.ts` (Requirement 11)

- `verifyShas(repo, report)`: for each entry, `git cat-file -e <sha>^{commit}`; failing
  entries are removed and listed in `droppedUnverified`. The same check runs on `baseSha`,
  `rejected`, `llmErrors` and `unguarded`.
- Totals: `processed`, `escaped`, `buried` and `lost` are computed from `entries`, and
  `unguarded` from the `unguarded` list, after verification, so they cannot drift. `commitsScanned`, `candidates`,
  `rejectedByLlm`, `llmErrors` and `unchecked` come from the scan and confirm phases, and
  `staleCleaned` from stale cleanup.
- `redactOptions(opts, apiKey?)`: `testCommand` and `installCommand` go through `redact()`
  (removes the API key), then leading inline env assignments are masked:
  `/^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)/` is rewritten so each `NAME=value` becomes
  `NAME=***`. Example: `TOKEN=abc DEBUG=1 npm test` → `TOKEN=*** DEBUG=*** npm test`.

### `index.ts`

Exports `resurrect`, the option, deps and report types, `HadesConfigError`, `matchRules`,
`makeTestFileMatcher`, `makeNonCodeMatcher`, `DEFAULT_TEST_PATTERNS` and
`DEFAULT_NON_CODE_PATTERNS` (matchers and patterns for reuse by the reviewer and memory
writer later), and `HadesAbortError` once abort support exists.

## Data Models

Option and dependency types are in Components and Interfaces (`config.ts`). The report types follow.

### Report types: `report/types.ts` (Requirement 11)

Defined early (task 3.7) so every module shares the same types.

```ts
type SummonLabel = "escaped" | "buried" | "lost";
type LostReason = "revert did not apply" | "timeout" | "dependency setup failed"
  | "no source files to revert" | "fix changes dependencies" | "flaky tests"
  | "test command failed to start" | "parent commit not available"
  | `internal error: ${string}`;

interface SummonEntry {
  sha: string;              // full 40-char SHA
  message: string;
  matchedRules: CandidateRule[];
  llmReason: string;
  filesReverted: string[];
  label: SummonLabel;
  lostReason?: LostReason;
  testOutputExcerpt: string;
  durationMs: number;
  runs: number;             // 1 until optional reruns exist
  cleanupWarning?: string;
}

interface UnguardedFix {   // Confirmed fix in a repo with no test suite
  sha: string;              // full 40-char SHA
  message: string;
  matchedRules: CandidateRule[];
  llmReason: string;
  files: string[];          // every path the fix changed (changedFiles), unclassified
}

interface UnderworldReport {
  status: "ok" | "baseline-failed" | "no-tests";
  repo: string;
  baseSha: string;
  options: ResolvedOptions;                       // redacted
  deps: { method: "link" | "install" | "none"; workspace: boolean };
  warnings: string[];
  baseline?: { passed: boolean; reason?: string; excerpt: string };
  entries: SummonEntry[];                         // always empty for no-tests
  unguarded: UnguardedFix[];                      // only filled for no-tests
  rejected:  { sha: string; message: string; reason: string }[];
  llmErrors: { sha: string; message: string; reason: string }[];
  totals: {
    // from the scan, confirm and cleanup phases
    commitsScanned: number; candidates: number; rejectedByLlm: number;
    llmErrors: number; unchecked: number; staleCleaned: number;   // staleCleaned 0 until optional
    // derived from entries
    processed: number; escaped: number; buried: number; lost: number;
    // derived from the unguarded list
    unguarded: number;
  };
  droppedUnverified: string[];                    // SHAs removed by verification (expected empty)
}
```

`flaky tests` stays in `LostReason` from the start so the type does not change later; it is
only produced once reruns exist. `SummonLabel` stays `escaped | buried | lost`; a repo with
no test suite is a report status, not a label. For `no-tests`, `deps` is
`{ method: "none", workspace: false }` because no dependency plan is made, and `baseline` is
absent. The type changes (`diff-review`, `no-tests`, `UnguardedFix`, `unguarded` list and
total) are made in task 8.0.

## Real-repo check: `scripts/summon.ts` (Requirement 14)

```
npm run summon -- <absolute repo path> [--limit N] [--test-command "<cmd>"] [--timeout <seconds>]
```

- Root script `summon` forwards to the engine's `summon` script (`tsx scripts/summon.ts`).
  Arguments are parsed with `node:util` `parseArgs` in a pure function
  `parseSummonArgs(argv)` (exported so it can be tested without running a summoning):
  - the repo path must be absolute;
  - `--limit` must be a positive integer;
  - `--test-command` must be a non-empty string after trimming; it becomes `testCommand`;
  - `--timeout` must be a positive integer number of seconds; it becomes
    `timeoutMs = seconds * 1000`;
  - unknown options or invalid values print a usage message and exit 1 before
    `resurrect()` is called.
  Options not given are left out of the call, so engine defaults apply. Passing
  `--test-command` also means the no-tests check is skipped (Requirement 9.5).
- Calls `resurrect(repo, { limit, testCommand, timeoutMs })` with no injected LLM, so the
  real client reads `HADES_LLM_BASE_URL`, `HADES_LLM_API_KEY` and `HADES_LLM_MODEL`.
- Writes the full report as JSON to
  `<home>/.hades/reports/<repo folder name>-<short base sha>-<yyyymmdd-hhmmss>.json`
  (creating the folder). If that path would be inside the target Repo, it refuses and exits
  1, so the script never writes into the Real working tree.
- Prints a plain summary:

  ```
  The Underworld · <repo> @ <short base sha>
  test command: npm test (default) · timeout 120s
  scanned 500 · candidates 42 · rejected 20 · llm errors 0 · unchecked 12
  processed 10 · escaped 3 · buried 5 · lost 2

  escaped  a1b2c3d  Fix retry on payment timeout
           reverted: src/pay.ts
  lost     9f8e7d6  fix: handle empty config
           reverted: src/config.ts
           reason: revert did not apply

  warnings: (none)
  report: C:\Users\<user>\.hades\reports\<file>.json
  ```

  The `test command:` line shows `report.options.testCommand`, which is already redacted
  (Requirement 11.5), so an inline `TOKEN=...` is printed as `TOKEN=***`. It adds
  `(default)` when `--test-command` was not given. For `no-tests` the line reads
  `test command: none (no test script in package.json)`, because nothing was run.

  For `baseline-failed` it prints the baseline reason and excerpt instead of entries. For
  `no-tests` it prints the scan totals line, then `No test suite. N past fixes are
  unguarded.` (N = `totals.unguarded`), then the report path.
- Exit code: 0 for `status: "ok"` and `no-tests`, 2 for `baseline-failed`, 1 when
  `resurrect()` throws (the error message is printed; it never contains the key).
- Until optional abort support exists, Ctrl+C while a test is running leaves one locked
  worktree in the temp dir. The script prints a one-line note about this at start.
- **Ctrl+C recovery commands.** The script (not the engine, which never installs signal
  handlers) registers a `SIGINT` handler. It finds the active worktree without any engine
  API change: it runs `git -C <repo> worktree list --porcelain` synchronously and picks the
  worktrees locked with `hades pid=<process.pid>` (the engine runs in the script's process,
  so the pid matches). For each one it prints the exact commands with the real paths filled
  in, in this order, then exits with code 130:

  1. Remove the dependency link **first**, before any git command, so nothing can follow it
     into the Repo's real `node_modules`. Printed only if `<worktree>/node_modules` is a
     link (`lstat`):
     - Windows: `cmd /c rmdir "<worktree>\node_modules"` (no `/s`). It is wrapped in
       `cmd /c` because in PowerShell `rmdir` is an alias for `Remove-Item`, which does not
       behave like cmd's `rmdir` on a junction.
     - POSIX: `rm "<worktree>/node_modules"` (no `-r`).
  2. `git -C "<repo>" worktree unlock "<worktree>"`
  3. `git -C "<repo>" worktree remove --force "<worktree>"`

  The handler only prints; it runs none of these commands. The optional stale cleanup
  (task 15.2) removes such worktrees automatically on a later run.

**Checkpoint:** run it on a real JS/TS repo cloned outside the Hades repo (never committed),
and get at least one `escaped` entry. Record the repo URL, base SHA and totals in the task
notes.

## Abort handling (optional, Requirement 7.1, 7.2)

- `resurrect` calls `signal.throwIfAborted()` (wrapped to throw `HadesAbortError`) before
  each phase and before each fix.
- Long operations receive the signal: `runCommand` kills the process tree on abort, LLM
  `fetch` is cancelled (the 30 s timeout and the run signal are combined with a small helper,
  so Node 20.0 works without `AbortSignal.any`), and `runGit` passes it to `execFile`.
- `createWorktree` never takes the signal, so it always finishes (or cleans up after itself).
  Callers call `throwIfAborted()` right after it, inside the `try` whose `finally` runs
  `removeWorktree`, so an abort that arrived during creation still removes the worktree.
- Cleanup never takes the signal, so an abort cannot interrupt it. Every worktree is removed
  before the `HadesAbortError` propagates. No partial report is returned.
- The engine never installs process signal handlers; `packages/mcp-server` will create an
  `AbortController` and wire SIGINT/SIGTERM to it.

## Stale cleanup (optional, Requirement 7.3–7.5): `summon/stale.ts`

At run start: `git worktree list --porcelain`, parsed into `{ path, locked?: reason }`
records. A worktree is stale only if **all** of these hold:

1. `basename(path)` starts with `hades-summon-`;
2. `realpath(path)` (or `path` if it no longer exists) is inside `realpath(os.tmpdir())`;
3. it is locked and the lock reason matches `/^hades pid=(\d+)$/`;
4. `process.kill(pid, 0)` throws with code `ESRCH` (no such process). `EPERM` means the
   process exists, so the worktree is left alone.

Stale worktrees are passed to `removeWorktree` (link first, unlock, same safety gate). An
unlocked `hades-summon-*` worktree is never removed: there is no pid to prove its owner is
gone. The count goes to `report.totals.staleCleaned`. A reused pid makes a stale worktree
look alive, which only means it is skipped this time; that is the safe direction.

## Error handling

| Situation | Result |
| --- | --- |
| Invalid options, path not a repo root, git < 2.30 | throw `HadesConfigError` before any work |
| Empty repo, no Candidates, no Confirmed fixes | `status: "ok"`, empty entries |
| No test suite (no `testCommand` given, no usable `scripts.test` in `HEAD:package.json`) | `status: "no-tests"`, no baseline, no worktrees, Confirmed fixes in `unguarded` |
| LLM env missing (Candidates exist, no fake client) | throw `HadesConfigError` naming the vars, before any worktree |
| LLM HTTP 401 / 403 / 404 | throw `HadesConfigError` naming the status |
| First 3 LLM checks all transport errors | throw `HadesConfigError("LLM unreachable")` |
| Other LLM error or invalid JSON on one Candidate | added to `llmErrors`; run continues |
| Baseline fails or times out | `status: "baseline-failed"` with hints, no LLM calls, no entries |
| Worktree add or lock fails | partial worktree removed; fix `lost` (or baseline fails) |
| Any other per-fix failure | entry labelled `lost` with a reason; run continues |
| (optional) Abort signal | process tree killed, worktree removed, throw `HadesAbortError` |
| Worktree cleanup partially fails | `cleanupWarning`; never a recursive delete through a link |

## Correctness properties

These map to Requirement 12 and are tested with fast-check. Anything that
builds a git repo runs 5 times by default, and 20 times when `HADES_PROPERTY_RUNS=20`. The
20-run pass is required before each release and in CI once it exists.

1. **Real working tree unchanged.** For any generated repo and options, the snapshot
   (all file bytes outside `.git`, `git ls-files -s` for the index, `git rev-parse HEAD`,
   `git for-each-ref`, `git stash list`, `git status --porcelain=v2 --ignored`) is equal
   before and after `resurrect`, including runs that end `lost` or `baseline-failed`.
2. **Reverse then re-apply restores.** For any generated fix commit, in a worktree at that
   commit: reverse-apply the source-file patch, then apply it forward; every file's bytes
   equal the original.
3. **Only source files reverted.** For any generated path set and extra patterns, no path in
   `filesReverted` matches the test matcher or the non-code matcher, and every reverted path
   was in the Fix diff.
4. **Every reported SHA exists.** Every `entries[].sha`, `rejected[].sha`, `llmErrors[].sha`,
   `unguarded[].sha` and `baseSha` passes `git cat-file -e`.
5. **No leftovers.** After a run, `git worktree list --porcelain` lists only the main tree,
   no `hades-summon-*` folder created by the run remains in the temp dir, and the Repo's
   `node_modules` marker file still exists.

(optional) Once abort support exists, properties 1 and 5 also generate runs that are aborted
at a random point.

Pure properties (100 runs, no git): `matchRules` never returns a Candidate for a message
whose only signal is a bare `#\d+` or `(#\d+)`; the file matchers give the same answer for
`\` and `/` separators; `redactOptions` output never contains the API key or an unmasked
leading `NAME=value`.

## Testing strategy

```
packages/engine/test/
  spike/apply-3way.test.ts  task 1: -R --3way and the fallback on clean and conflicting patches
  helpers/repo.ts           makeRepo(spec) in os.tmpdir(): git init, local user.name/email,
                            core.autocrlf=false, writes commits from a spec, adds
                            node_modules/marker.txt (gitignored)
  helpers/snapshot.ts       snapshot(repo) for property 1
  helpers/fake-llm.ts       scripted LlmClient (confirm / reject / invalid JSON /
                            network error / HTTP status)
  helpers/arbitraries.ts    fast-check generators: file trees (src/, lib/, docs/, test/,
                            __tests__/, *.spec.ts, *.md, package.json), fix commits touching
                            mixed files, later commits that sometimes conflict with a fix
  candidates.test.ts        examples + pure properties
  select-candidates.test.ts diff-review triggers (<= 50 commits; < 3 message matches),
                            message mode otherwise, rule lists, newest-first order, and the
                            maxLlmChecks / limit caps applied to diff-review Candidates
  dependency-change.test.ts lockfile always counts; package.json version-only, exports,
                            types or scripts change does not; each dependency field change
                            does; added, deleted or invalid-JSON package.json counts
  summon-args.test.ts       parseSummonArgs: --test-command and --timeout parsed and
                            converted; empty command, zero/negative/non-integer timeout and
                            unknown options rejected
  test-suite.test.ts        no package.json, no scripts.test, empty, npm default, real
                            script, invalid JSON (treated as a test suite)
  files.test.ts             test, non-code and dependency-file matchers
  redact.test.ts            key removal, env-assignment masking
  llm-confirm.test.ts       fence stripping, zod failures, 401/403/404 throw, unreachable
                            after 3 transport errors, errors count toward maxLlmChecks
  process.test.ts           exit codes; timeout kills a child-spawning node script tree;
                            excerpt bounded; key not visible to the child
  deps.test.ts              plan table; link created and removed; target marker survives
  worktree.test.ts          lock reason set after add; add or lock failure leaves nothing
                            behind; unlock + remove; prune when the folder was already gone;
                            stuck link blocks the recursive delete
  baseline.test.ts          hints for .gitmodules, LFS, ignored .env
  resurrect.test.ts         end-to-end: escaped, buried, lost (conflict, source-free fix,
                            dependency fix), baseline-failed (no LLM calls made), limit and
                            maxLlmChecks caps, no-tests (repo without a test script: no
                            worktree created, fixes in unguarded, SHAs verified), explicit
                            testCommand bypasses the no-tests check
  properties.test.ts        properties 1–5
  (optional) abort.test.ts, stale.test.ts, workspace.test.ts, rerun.test.ts
```

The fake test command used by generated repos is a small Node script committed into the
generated repo (`node check.mjs`), which exits 1 if a file contains a `BUG` marker. A fix
commit removes the marker; summoning brings it back. Whether the test "catches" it is
controlled by the generator, so `escaped` and `buried` are both produced. No real `npm`, no
network.

Generated repos have far fewer than 50 commits, so `resurrect()` runs them in diff-review
mode: every commit is a Candidate. End-to-end and property tests therefore script the fake
LLM per commit (for example, confirm only messages containing a marker), rather than relying
on the message rules to filter. Those tests pass `testCommand: "node check.mjs"`
explicitly, so the no-tests check does not apply to them.

Optional-feature notes: the flaky variant of `check.mjs` fails on the first run and passes on
the next (using a counter file outside the worktree). Stale-cleanup tests get a dead pid by
spawning `node -e ""`, waiting for it to exit, and using its pid.

## Trade-offs

- **Base at HEAD only.** Matches "would the current tests miss it", at the cost of more `lost`
  results for old fixes. Decided; no fallback mode.
- **Separate `worktree lock` call** instead of `add --lock --reason`: one extra git call and
  a short unlocked window, in exchange for working on git 2.30.
- **Per-path `git diff` calls** instead of one diff split in TypeScript: more git calls, but
  no fragile parsing of `diff --git` headers with spaces or quoted names.
- **Linking `node_modules`** is fast but shared, so a test suite that writes into
  `node_modules` (some caches do) writes into the real one. Cleanup never deletes through
  the link. Callers who want full isolation set `alwaysInstall` with an `installCommand`.
- **Dependency-changing fixes are `lost` when linked**, because the linked packages match
  HEAD's manifest, not the reverted one, so the result would be meaningless.
- **Sequential summoning.** Slower than parallel, but keeps CPU, disk and port use
  predictable and makes cleanup simple.
- **Diff-review mode costs LLM calls** on small or poorly worded histories (up to
  `maxLlmChecks` per run), in exchange for finding fixes whose messages do not say "fix".
- **`unguarded` lists every changed file**, not only Source files, because nothing is
  reverted for `no-tests` and the user sees the whole fix.
- **Optional features deferred.** Abort, stale cleanup, workspace detection and reruns wait
  until the real-repo check shows the core works, so the riskiest path is proven first.
