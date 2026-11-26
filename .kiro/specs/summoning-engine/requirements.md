# Requirements Document

## Introduction

This document specifies the Summoning Engine.

The summoning engine lives in `packages/engine`. It finds past bug-fix commits in a git
repository (The Graveyard), brings each bug back by reverse-applying the source-code part of
its fix inside a temporary git worktree, runs the repo's tests, and labels the result:

- `escaped`: tests passed with the bug back in (an escaped soul)
- `buried`: tests failed, so they catch the bug
- `lost`: the run could not give a trustworthy answer (revert failed, setup failed, timeout,
  and similar)

The output is a report (The Underworld). The engine never touches the user's real working
tree, never reverts test files, and never reports a SHA that does not exist.

This spec also covers setting up the npm workspaces monorepo, with `packages/engine` as the
only package for now, and a script to run the engine against a real repo.

Criteria marked **(optional)** are built after the real-repo check (Requirement 14) passes.
Until then the engine works without them.

## Glossary

- **Repo**: the user's git repository, given as an absolute path.
- **Real working tree**: the Repo's checked-out files, index, HEAD and branches.
- **Candidate**: a commit that matches the bug-fix heuristics in Requirement 2.
- **Confirmed fix**: a Candidate the LLM classified as a bug fix.
- **Fix diff**: the changes between a Confirmed fix and its first parent.
- **Test file**: a path matching the test-file patterns in Requirement 4.
- **Non-code file**: a path matching the non-code patterns in Requirement 4.
- **Source files**: the paths in a Fix diff that are neither Test files nor Non-code files.
  Only Source files are reverted.
- **Summoning worktree**: a temporary `git worktree` created for one run step.
- **Base commit**: the Repo's HEAD at the start of the run.
- **Workspace repo**: a Repo whose packages link to each other (Requirement 6.1).

## Requirements

### Requirement 1: Monorepo setup

**User Story:** As a Hades developer, I want an npm workspaces monorepo with strict
TypeScript, Vitest and fast-check, so the engine can be built and tested on its own.

#### Acceptance criteria

1. THE repo root SHALL have a `package.json` with `"private": true`, `"type": "module"`,
   `"workspaces": ["packages/*"]`, and `engines.node` set to `>=20`.
2. THE repo SHALL contain `packages/engine` as the only workspace package.
3. THE root SHALL have a shared `tsconfig.base.json` with `strict: true`, ES module output,
   and NodeNext module resolution; `packages/engine/tsconfig.json` SHALL extend it.
4. WHEN a developer runs `npm install` then `npm test` at the root, THE engine's Vitest suite
   SHALL run, including fast-check property tests.
5. WHEN a developer runs `npm run build` at the root, THE engine SHALL compile with zero
   TypeScript errors.
6. THE repo SHALL have a `.gitignore` that ignores `node_modules`, build output and `.env`
   files, and SHALL NOT ignore `.kiro/`.
7. THE engine package SHALL NOT depend on MCP, VS Code or GitHub libraries.
8. THE engine package SHALL have a README stating that summoning runs the Repo's own test
   scripts, that `installCommand` runs install scripts, and that both should only be used on
   repos the user trusts.

### Requirement 2: Find bug-fix candidates

**User Story:** As a user, I want Hades to find commits that probably fixed bugs, so it knows
which bugs to summon.

#### Acceptance criteria

1. WHEN the engine scans a Repo, THE engine SHALL read at most the newest `maxCommits`
   commits reachable from HEAD (default 500, configurable) using real git commands.
2. THE engine SHALL mark a commit as a Candidate IF its message matches any of:
   1. the whole words `fix`, `fixes`, `fixed`, `fixing`, `bugfix`, `bug`, `crash`, `hotfix`
      or `revert`, case-insensitive;
   2. a closing-keyword issue link: one of `fix`, `fixes`, `fixed`, `close`, `closes`,
      `closed`, `resolve`, `resolves`, `resolved`, followed by whitespace and `#<digits>`,
      case-insensitive;
   3. a git revert commit (subject starts with `Revert "` or body contains
      `This reverts commit <sha>`).
3. A bare issue reference such as `#123` or `(#123)` without a closing keyword SHALL NOT, on
   its own, make a commit a Candidate.
4. THE engine SHALL skip merge commits and root commits (commits without exactly one parent).
5. THE engine SHALL confirm Candidates newest first. WHERE a `limit` option is given, THE
   engine SHALL stop calling the LLM once `limit` Confirmed fixes are found.
6. THE engine SHALL make at most `maxLlmChecks` LLM confirmation calls per run (default 50,
   configurable). Failed calls count toward this cap. Candidates not checked because of
   `limit` or this cap SHALL be counted in the report as `unchecked`.
7. THE engine SHALL record, for each Candidate, which rule(s) in 2.2 it matched.
8. IF the scanned history has at most 50 non-merge commits, OR fewer than 3 scanned commits
   match the rules in 2.2, THEN THE engine SHALL make every scanned non-merge, non-root
   commit a Candidate, newest first, and SHALL add the rule `diff-review` to each of them
   (commits that also matched 2.2 keep those rules too).
9. Diff-review Candidates SHALL be confirmed by the same LLM call as other Candidates
   (commit message plus diff summary), and SHALL be capped by `maxLlmChecks` and `limit` in
   the same way.

### Requirement 3: Confirm candidates with an LLM

**User Story:** As a user, I want each candidate checked by an LLM, so commits that only
mention "fix" in passing (e.g. "fix typo in README") are not summoned, and I want LLM
problems reported as problems, not as an empty result.

#### Acceptance criteria

1. THE engine SHALL call an OpenAI-compatible chat completions endpoint configured by the
   environment variables `HADES_LLM_BASE_URL`, `HADES_LLM_API_KEY` and `HADES_LLM_MODEL`.
2. IF any of these variables is missing when confirmation is needed, THEN THE engine SHALL
   fail before creating any worktree, with an error naming the missing variable(s).
3. THE engine SHALL send the commit message and a size-limited summary of the Fix diff, and
   SHALL request a JSON object `{ "isBugFix": boolean, "reason": string }`.
4. THE prompt SHALL state that a commit reverting a bug fix (for example `Revert "Fix ..."`)
   is not a bug fix and must be answered with `isBugFix: false`.
5. THE engine SHALL validate the LLM response with a zod schema.
6. WHEN the LLM answers `isBugFix: false`, THE engine SHALL record the Candidate in
   `rejected` with the LLM's reason.
7. IF the response is not valid JSON or fails validation, or the request fails or times out,
   THEN THE engine SHALL record the Candidate in `llmErrors` with the reason, and SHALL
   continue with the other Candidates.
8. IF the LLM endpoint answers HTTP 401, 403 or 404, THEN THE engine SHALL stop the run with
   a configuration error naming the status.
9. IF the first 3 LLM checks of a run all fail with network or HTTP errors, THEN THE engine
   SHALL stop the run with the configuration error `LLM unreachable`.
10. THE engine SHALL NEVER write the API key to logs, errors, reports or files.
11. THE LLM client SHALL be injectable, so tests run without network access.

### Requirement 4: Choose which files to revert

**User Story:** As a user, I want Hades to only revert source code, so the tests that should
catch the bug stay intact and docs-only changes are not summoned.

#### Acceptance criteria

1. THE engine SHALL classify a path as a Test file IF it matches any default pattern:
   `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/__mocks__/**`, `**/test/**`,
   `**/tests/**`, `**/fixtures/**`, or a caller-provided `extraTestPatterns` entry.
2. THE engine SHALL classify a path as a Non-code file IF it matches any default pattern:
   `**/*.md`, `**/*.mdx`, `**/*.txt`, `**/docs/**`, `**/.github/**`, `**/LICENSE*`,
   `**/CHANGELOG*`, `**/.vscode/**`, `**/.kiro/**`, or a caller-provided
   `extraNonCodePatterns` entry.
3. THE set of reverted files SHALL be exactly the Source files of the Fix diff.
4. THE engine SHALL NEVER include a Test file or a Non-code file in the set of reverted files.
5. IF a Fix diff has no Source files, THEN THE engine SHALL label the fix `lost` with the
   reason `no source files to revert`, without creating a worktree.
6. IF the fix makes a dependency change (4.7), AND dependencies would be linked rather than
   installed, THEN THE engine SHALL label the fix `lost` with the reason
   `fix changes dependencies`, without creating a worktree.
7. A fix makes a dependency change IF its non-test files include, in any folder:
   1. a lockfile: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
      `bun.lockb` or `bun.lock` (always a dependency change); or
   2. a `package.json` whose `dependencies`, `devDependencies`, `peerDependencies`,
      `optionalDependencies` or `bundleDependencies` differ between the fix's parent and the
      fix, compared as parsed JSON. IF either version is missing or fails to parse as a JSON
      object, THEN it SHALL count as a dependency change.
8. A `package.json` that changed only other fields (for example `version`, `exports`,
   `types` or `scripts`) SHALL be treated as a normal Source file and reverted.

### Requirement 5: Summon in a temporary worktree

**User Story:** As a user, I want each bug brought back in an isolated copy of my repo, so my
own files are never at risk.

#### Acceptance criteria

1. FOR each Confirmed fix, THE engine SHALL create a Summoning worktree in the OS temp
   directory in two steps: `git worktree add --detach <dir> <base>`, then
   `git worktree lock --reason "hades pid=<pid>" <dir>`. The lock is required.
2. THE Base commit SHALL be the Repo's current HEAD, so the run shows whether the current
   tests would miss the old bug. There is no fallback to the fix commit.
3. THE engine SHALL reverse-apply the Source files of the Fix diff inside the Summoning
   worktree only, using the command chosen by the spike (`git apply -R --3way`, or the
   forward-patch fallback).
4. IF the reverse-apply exits non-zero or leaves unmerged paths, THEN THE engine SHALL label
   the fix `lost` with the reason `revert did not apply` and SHALL NOT run tests.
5. THE engine SHALL unlock and remove the Summoning worktree after every step, including
   after errors, timeouts and thrown exceptions.
6. THE engine SHALL NEVER change the Real working tree: files, index, HEAD, branches and
   stash SHALL be identical before and after a summoning run.
7. THE engine SHALL process Confirmed fixes one at a time.
8. IF any step of creating a Summoning worktree fails (including the lock), THEN THE engine
   SHALL remove the partial worktree before reporting the failure.

### Requirement 6: Prepare dependencies in the worktree

**User Story:** As a user, I want the summoned copy to use my installed dependencies when
that is safe, so the tests can run without a slow reinstall.

#### Acceptance criteria

1. **(optional)** THE engine SHALL treat the Repo as a Workspace repo IF its root
   `package.json` has a `workspaces` field, OR `pnpm-workspace.yaml` exists at the root, OR
   any entry in the Repo's `node_modules` is a symlink that resolves inside the Repo.
2. WHERE `alwaysInstall` is true, THE engine SHALL run `installCommand` in the Summoning
   worktree and never link. `alwaysInstall` without `installCommand` SHALL be a
   configuration error.
3. **(optional)** IF the Repo is a Workspace repo AND `installCommand` is set, THEN THE
   engine SHALL install and never link.
4. **(optional)** IF the Repo is a Workspace repo AND `installCommand` is not set, THEN THE
   engine SHALL link and add the report warning: `workspace repo: linked node_modules may
   resolve sibling packages to the real working tree; results may be unreliable. Set
   installCommand.`
5. OTHERWISE, IF the Repo root contains a `node_modules` directory, THE engine SHALL link it
   into the Summoning worktree root: a directory junction on Windows, a symlink on POSIX.
6. IF linking fails AND `installCommand` is set, OR the Repo has no `node_modules` AND
   `installCommand` is set, THEN THE engine SHALL run `installCommand`.
7. IF the Repo has no `node_modules` AND no `installCommand` is set, THEN THE engine SHALL
   run the test command anyway.
8. THE install command SHALL use `installTimeoutMs` (default 600000) as its timeout.
9. IF linking fails with no `installCommand`, or the install fails or times out, THEN THE
   engine SHALL label the step `lost` with the reason `dependency setup failed`.
10. WHEN removing a Summoning worktree, THE engine SHALL remove the link itself first,
    without following it, so the Repo's real `node_modules` is never deleted by cleanup.

### Requirement 7: Interrupted and stale runs (optional)

**User Story:** As a user, I want a cancelled or crashed run to leave nothing behind, so
summoning never accumulates junk worktrees in my repo.

#### Acceptance criteria

1. **(optional)** THE engine SHALL accept an optional `AbortSignal`. WHEN it is aborted, THE
   engine SHALL kill the running test or install process tree, remove the active Summoning
   worktree, and reject with `HadesAbortError`.
2. THE engine SHALL NOT install process signal handlers itself.
3. **(optional)** AT the start of every run, THE engine SHALL remove each stale Hades
   worktree: a worktree whose folder name starts with `hades-summon-`, is inside the OS temp
   directory, and whose lock reason is `hades pid=<pid>` for a process that no longer exists.
4. During stale cleanup, THE engine SHALL NEVER remove a worktree whose lock names a living
   process, whose lock reason is not a Hades one, or that is not locked.
5. **(optional)** THE report SHALL include the number of stale worktrees removed as
   `staleCleaned`.

### Requirement 8: Run tests with a timeout

**User Story:** As a user, I want the repo's tests run against each summoned bug, with a
time limit, so one hanging run cannot block Hades.

#### Acceptance criteria

1. THE engine SHALL run the test command inside the Summoning worktree. THE test command
   SHALL default to `npm test` and SHALL be configurable.
2. THE timeout SHALL default to 120 seconds and SHALL be configurable.
3. WHEN the timeout is reached, THE engine SHALL kill the test process and its child
   processes (on Windows and POSIX) and label the fix `lost` with the reason `timeout`.
4. THE engine SHALL capture combined stdout and stderr and keep an excerpt of at most
   `excerptChars` characters (default: the last 4000).
5. BEFORE summoning any fix, THE engine SHALL run the test command once on an unmodified
   worktree at the Base commit (the baseline).
6. IF the baseline does not pass, THEN THE engine SHALL stop and return a report stating that
   tests fail without any bug summoned. THE reason SHALL include a hint when the Repo has
   `.gitmodules` (submodules are not initialised in the worktree), uses Git LFS
   (`.gitattributes` contains `filter=lfs`), or has gitignored `.env*` files (not present in
   the worktree).
7. **(optional)** WHERE `rerunOnFail` is N (default 0, max 3), WHEN the tests exit non-zero,
   THE engine SHALL rerun them up to N times.

### Requirement 9: Repos without a test suite

**User Story:** As a user of a repo with no tests, I want Hades to tell me which past fixes
nothing guards, instead of failing.

#### Acceptance criteria

1. THE engine SHALL treat the Repo as having no test suite IF the caller did not set
   `testCommand`, AND the Base commit has no root `package.json`, or its `scripts.test` is
   missing, empty, or npm's default (it contains `no test specified`).
2. WHEN the Repo has no test suite, THE engine SHALL NOT run the baseline, SHALL NOT create
   any worktree, and SHALL NOT run any command from the Repo.
3. WHEN the Repo has no test suite, THE engine SHALL still confirm Candidates with the LLM
   (same caps), and SHALL put every Confirmed fix into the report list `unguarded`, not into
   `entries`.
4. WHEN the Repo has no test suite, THE report status SHALL be `no-tests`, including when
   there are no Candidates.
5. WHEN the caller set `testCommand`, THE engine SHALL skip this check and run as usual.

### Requirement 10: Label results

**User Story:** As a user, I want each summoned bug clearly labelled, so I know which old
bugs my tests would miss.

#### Acceptance criteria

1. WHEN the test command exits with code 0, THE engine SHALL label the fix `escaped`.
2. WHEN the test command exits non-zero before the timeout (and, if reruns are enabled, no
   rerun passes), THE engine SHALL label the fix `buried`.
3. **(optional)** WHEN a rerun passes after a failing run, THE engine SHALL label the fix
   `lost` with the reason `flaky tests`.
4. WHEN worktree creation, dependency setup, reverse-apply or test-process startup fails, or
   the run times out, THE engine SHALL label the fix `lost` and record the reason.
5. EVERY processed Confirmed fix SHALL receive exactly one label.

### Requirement 11: Report (The Underworld)

**User Story:** As a user, I want a report of every summoning, so I can see which bugs
escaped and why.

#### Acceptance criteria

1. THE engine SHALL return a report with one entry per processed Confirmed fix containing:
   full SHA, commit message, files reverted, label, `lost` reason (if any), test output
   excerpt, and duration.
2. THE report SHALL contain totals. `processed`, `escaped`, `buried` and `lost` SHALL be
   derived from the entries. `commitsScanned`, `candidates`, `rejectedByLlm`, `llmErrors`
   and `unchecked` SHALL come from the scan and confirm phases. `unguarded` SHALL be derived
   from the `unguarded` list. `staleCleaned` SHALL come from stale cleanup and is 0 until
   that optional feature exists.
3. THE report SHALL list `rejected` (LLM said not a bug fix) and `llmErrors` (request
   failed or invalid response) separately, and SHALL include report-level `warnings`.
4. BEFORE returning, THE engine SHALL verify every SHA in the report (entries, `rejected`,
   `llmErrors`, `unguarded` and the Base commit) exists in the Repo as a commit
   (`git cat-file -e <sha>^{commit}`), and SHALL drop and list any item that fails.
5. THE options stored in the report SHALL have secrets redacted: the API key removed, and
   inline env assignments at the start of `testCommand` or `installCommand` written as
   `NAME=***`.
6. THE report SHALL be a typed, JSON-serialisable object.
7. THE report status SHALL be one of `ok`, `baseline-failed` or `no-tests`. THE labels
   `escaped`, `buried` and `lost` SHALL NOT change.
8. EACH `unguarded` item SHALL contain the full SHA, commit message, matched rules, the LLM's
   reason, and the files the fix changed.

### Requirement 12: Property tests

**User Story:** As a Hades developer, I want the safety guarantees proven by property tests,
so they hold for many generated repos, not just a few examples.

#### Acceptance criteria

1. THE test suite SHALL include fast-check property tests that build generated git repos in
   temp directories and check:
   1. the Real working tree (files, index, HEAD, branches) is unchanged after any summoning
      run, including runs that end `lost` or `baseline-failed`;
   2. reverse-applying a Fix diff and then re-applying it restores the exact original file
      contents;
   3. no Test file and no Non-code file is ever in a reverted file set;
   4. every SHA in a report exists in the Repo.
2. THE property tests SHALL use a fake LLM client and a fast fake test command, so they run
   offline.
3. Properties that build git repos SHALL use 5 runs by default, and 20 when
   `HADES_PROPERTY_RUNS=20`. The 20-run pass is required before each release and in CI once
   it exists.
4. THE property tests SHALL also check that no Summoning worktree remains (on disk or in
   `git worktree list`) after a run, and that the Repo's `node_modules` is intact after
   cleanup.
5. **(optional)** WHEN abort support exists, properties 12.1.1 and 12.4 SHALL also cover
   aborted runs.

### Requirement 13: Configuration

**User Story:** As a caller (later, the MCP server), I want to pass all settings as function
options, so the engine has no hidden config sources.

#### Acceptance criteria

1. THE engine SHALL accept these options, all optional, with these defaults: `testCommand`
   (`npm test`), `timeoutMs` (120000), `limit` (none), `maxCommits` (500), `maxLlmChecks`
   (50), `extraTestPatterns` (none), `extraNonCodePatterns` (none), `installCommand` (none),
   `installTimeoutMs` (600000), `alwaysInstall` (false), `excerptChars` (4000), and
   **(optional)** `rerunOnFail` (0, max 3).
2. THE engine SHALL NOT read Hades configuration from files in the Repo, and SHALL NOT write
   any configuration inside `.kiro/`.
3. LLM connection settings SHALL come only from the environment variables in Requirement 3.1.

### Requirement 14: Real-repo check

**User Story:** As a Hades developer, I want to run the engine on a real repo from the
command line, so I can see that summoning works outside generated test repos.

#### Acceptance criteria

1. THE repo SHALL provide `npm run summon -- <absolute repo path> [--limit N]
   [--test-command "<cmd>"] [--timeout <seconds>]` at the root, backed by
   `packages/engine/scripts/summon.ts`. `--test-command` SHALL be passed to `resurrect()` as
   `testCommand`, and `--timeout` as `timeoutMs` (seconds × 1000). Invalid values SHALL
   make the script exit 1 with a usage message, before calling `resurrect()`.
2. THE script SHALL call `resurrect()` with the real LLM client (from the environment
   variables in Requirement 3.1).
3. THE script SHALL print the test command being used (redacted as in 11.5) in the summary
   header. THE script SHALL print a readable summary: the totals first, then for each entry its
   label, short SHA, message, files reverted and `lost` reason. WHEN the status is
   `no-tests`, it SHALL print `No test suite. N past fixes are unguarded.` with N the number
   of `unguarded` items.
4. THE script SHALL write the full JSON report to a file outside the target Repo and print
   that file's path.
5. THE script SHALL exit non-zero when `resurrect()` throws or the baseline fails, and SHALL
   exit 0 for `no-tests`.
6. THE real-repo check SHALL pass when the script, run on a real JS/TS repo, produces at
   least one `escaped` entry.
7. WHEN the user presses Ctrl+C during a run, THE script SHALL print, with real paths filled
   in, the commands to remove the dependency link first (Windows `rmdir` without `/s`, POSIX
   `rm` without `-r`), then `git worktree unlock` and `git worktree remove --force`, and
   SHALL NOT run them itself.

## Decisions

1. **Dependencies:** link the Repo's `node_modules` by default (junction on Windows, symlink
   on POSIX). Install instead when `alwaysInstall` is set, or (optional) when a Workspace
   repo has an `installCommand`.
2. **Base commit:** always current HEAD. No fallback to the fix commit.
3. **Timeout label:** `lost`, reason `timeout`.
4. **Config source:** function options only.
5. **Worktree lock:** required, done with a separate `git worktree lock --reason` call,
   because `git worktree add --reason` needs a newer git than the 2.30 minimum.
6. **Optional features** (abort, stale cleanup, workspace detection, reruns) are built only
   after the real-repo check passes.
