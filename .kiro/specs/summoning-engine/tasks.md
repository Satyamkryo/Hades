# Implementation Plan: Summoning Engine

## Overview

This plan builds the summoning engine in `packages/engine/`. The engine finds past bug-fix
commits, confirms them with an LLM, undoes each fix in a temporary git worktree, runs the
repo's tests, and labels each result `escaped`, `buried` or `lost`. Work starts with a
Windows spike on `git apply -R --3way`, then foundation, history, LLM confirmation,
worktrees, summoning, a real-repo check, property tests and a README.

## Tasks

Each task ends with its tests passing (`npm test` at the root). Checkpoints must pass before
the next group starts. Paths are relative to `packages/engine/` unless they start at the
repo root. Tasks marked `*` are optional and are done only after the real-repo check
(task 12) passes.

- [x] 1. Spike: confirm `git apply -R --3way` behaviour
  - [x] 1.1 Scaffold the monorepo just enough to run the spike: root `package.json`
    (private, `type: module`, `workspaces: ["packages/*"]`, `engines.node >=20`, `build` and
    `test` scripts), `tsconfig.base.json` (strict, NodeNext, ES2022,
    `noUncheckedIndexedAccess`), `.gitignore` (`node_modules/`, `dist/`, `coverage/`,
    `.env`, `.env.*`; not `.kiro/`), `packages/engine/package.json` (`@hades/engine`),
    `tsconfig.json`, `vitest.config.ts`; dev deps `typescript`, `vitest`, `fast-check`,
    `@types/node`
    - _Requirements: 1.1, 1.2, 1.3, 1.6_
  - [x] 1.2 Write `test/spike/apply-3way.test.ts`: build a temp repo with commits A (base),
    F (a fix changing `src/a.js`), L (a later commit changing lines next to the fix), plus
    a case where L rewrites the fixed lines. In a `git worktree add --detach` at L, run
    `git apply -R --3way` with the patch from `git diff --binary --full-index F^ F`.
    Assert: exit 0 and the expected file content for the clean case; non-zero exit and a
    path in `git diff --name-only --diff-filter=U` for the conflict case; afterwards
    `git status` works in the worktree and `git worktree remove --force` succeeds
  - [x] 1.3 Add the fallback variant to the same test: patch from `git diff F F^`, applied
    with `git apply --3way` (no `-R`), same assertions
  - [x] 1.4 Run the spike on Windows (required). Record the exact `git --version` and the
    results in the "Spike result" section of `design.md`, and pick `-R --3way` or the
    fallback. Update the `history/fix-diff.ts` and `summon/apply.ts` sections if the
    fallback is chosen
    - _Requirements: 5.3, 5.4_

- [x] 2. Checkpoint: Windows spike result recorded in `design.md` and approved before task 3

- [x] 3. Foundation: config, errors, git exec, repo validation, report types
  - [x] 3.1 Add runtime deps `zod`, `picomatch` and dev dep `@types/picomatch`
  - [x] 3.2 `src/errors.ts`: `HadesConfigError`, `GitError`
  - [x] 3.3 `src/config.ts`: `ResurrectOptions`, `ResurrectDeps` (`llm` only for now), zod
    schema, defaults, `resolveOptions` (including `alwaysInstall` requires
    `installCommand`); unit tests for defaults and every rejection
    - _Requirements: 13.1, 13.2, 6.2_
  - [x] 3.4 `src/git/exec.ts`: `runGit` via `execFile`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`,
    `allowFail`
  - [x] 3.5 `src/repo/validate.ts`: git >= 2.30 check, absolute path equals
    `--show-toplevel` after `realpath`, Base commit from `HEAD`, empty-repo detection;
    tests with a temp repo, a subfolder and a non-repo folder
  - [x] 3.6 `test/helpers/repo.ts` (`makeRepo` from a commit spec, `core.autocrlf=false`,
    gitignored `node_modules/marker.txt`) and `test/helpers/snapshot.ts`
  - [x] 3.7 `src/report/types.ts`: `SummonLabel`, `LostReason` (all reasons, including
    `flaky tests`), `SummonEntry`, `UnderworldReport` with `rejected`, `llmErrors`,
    `warnings`, `deps` and the full `totals` shape from the design
    - _Requirements: 11.1, 11.2, 11.3, 11.6_

- [x] 4. History: scan, candidates, file selection, fix diff
  - [x] 4.1 `src/history/candidates.ts`: `matchRules` with the `keyword`, `closing-issue`
    and `revert` rules; example tests (including `fixing`, `bugfix`, `Fixes #12`, bare
    `#123`, `(#123)`, `Revert "Fix x"`); pure property: a bare `#\d+` / `(#\d+)` alone is
    never a Candidate (100 runs)
    - _Requirements: 2.2, 2.3, 2.7_
  - [x] 4.2 `src/history/scan.ts`: `git log -n <maxCommits>` with `%x00`/`%x1e`, trim each
    record before splitting, drop root and merge commits; tests for multi-line messages,
    merges, root commit and the `maxCommits` cap
    - _Requirements: 2.1, 2.4_
  - [x] 4.3 `src/classify/files.ts`: default test and non-code patterns, extra patterns,
    `isDependencyFile`, `selectFiles`; example tests and pure property: matchers agree for
    `\` and `/` separators
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x] 4.4 `src/history/fix-diff.ts`: `changedFiles` (`-z`, `--no-renames`), `fixPatch`
    (per path, `:(literal)`, `--binary --full-index`, commit order per spike), `diffSummary`;
    tests for spaces and `*` in filenames, renames across `src/`→`test/`, binary files,
    missing parent → `parent commit not available`
    - _Requirements: 4.3, 5.3_

- [x] 5. LLM confirmation
  - [x] 5.1 `src/llm/env.ts`: `readLlmEnv` with an error naming every missing variable
    - _Requirements: 3.1, 3.2_
  - [x] 5.2 `src/report/redact.ts`: `redact()` for the key and `redactOptions()` for
    `testCommand` / `installCommand` env assignments; example tests and pure property
    (output never contains the key or an unmasked leading `NAME=value`)
    - _Requirements: 3.10, 11.5_
  - [x] 5.3 `src/llm/client.ts`: OpenAI-compatible `fetch` client with a 30 s timeout,
    `LlmHttpError`, `LlmNetworkError`, key redacted from every error; tests against a local
    `node:http` server
    - _Requirements: 3.1, 3.10, 3.11_
  - [x] 5.4 `src/llm/confirm.ts`: system prompt (JSON only; reverting a bug fix is not a bug
    fix), fence stripping, zod schema, `confirmed` / `rejected` / `error` results,
    401/403/404 → `HadesConfigError`; `test/helpers/fake-llm.ts`; tests for each outcome
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
  - [x] 5.5 Confirmation loop: newest first, stop at `limit` or `maxLlmChecks` (errors
    count), split `rejected` and `llmErrors`, `LLM unreachable` after 3 transport errors at
    the start, `unchecked` count; tests with the fake client
    - _Requirements: 2.5, 2.6, 3.6, 3.7, 3.9_

- [x] 6. Checkpoint: `npm run build` and `npm test` pass; no worktrees created yet

- [x] 7. Processes and worktrees
  - [x] 7.1 `src/summon/process.ts`: `runCommand` with `shell: true`,
    `stdio: ["ignore", "pipe", "pipe"]`, `detached` on POSIX, `CI=true`, API key removed
    from env, rolling excerpt buffer, timeout kills the process tree (`kill(-pid)` /
    `taskkill /T /F`), 5 s close fallback; tests: exit codes, spawn error, timeout kills a
    child-spawning `node` script, excerpt bounded, `HADES_LLM_API_KEY` not visible to the
    child
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 7.2_
  - [x] 7.2 `src/summon/worktree.ts`: `createWorktree` in two steps
    (`git worktree add --detach <dir> <base>`, then
    `git worktree lock --reason "hades pid=<process.pid>" <dir>`), removing its own partial
    worktree via `removeWorktree` before rethrowing if any step fails; `removeWorktree`
    (note `existedAtStart`, remove link, unlock, `remove --force`, safety gate + `fs.rm`,
    `prune` when `fs.rm` ran or the folder was already gone). Tests: lock reason shows in
    `git worktree list --porcelain`; a forced lock failure leaves no worktree or folder;
    removal leaves nothing in `git worktree list`; prune runs when the folder was deleted
    beforehand; a stuck link blocks the recursive delete and sets `cleanupWarning`
    - _Requirements: 5.1, 5.5, 5.8, 6.10_
  - [x] 7.3 `src/summon/deps-plan.ts` and `src/summon/deps.ts` (no workspace detection
    yet): plan rows for `alwaysInstall`, `node_modules` present, `installCommand`, none;
    link with `path.resolve` target and `junction`/`dir`; install with `installTimeoutMs`;
    link-failure fallback; `removeLink` (`unlink`, `rmdir` fallback). Tests for every plan
    row and that the Repo's `node_modules/marker.txt` survives link removal
    - _Requirements: 6.2, 6.5–6.10_
  - [x] 7.4 `src/summon/apply.ts`: reverse-apply per the spike result, success only if exit 0
    and no unmerged paths; tests for clean and conflicting patches
    - _Requirements: 5.3, 5.4_

- [x] 8. Summoning
  - [x] 8.0 Diff-based Candidates and report type updates (tasks 4.1 and 5.5 stay done;
    `matchRules` and the confirmation loop are not changed)
    - Add `diff-review` to `CandidateRule` (it is declared in both
      `src/history/candidates.ts` and `src/report/types.ts`; keep them identical or make
      one re-export the other)
    - `selectCandidates(commits)` in `src/history/candidates.ts`: diff-review mode when
      the scanned history has at most 50 commits or fewer than 3 match `matchRules`; then
      every scanned commit is a Candidate, newest first, with `diff-review` appended to its
      rules; otherwise message mode as before
    - `src/report/types.ts`: status `"ok" | "baseline-failed" | "no-tests"`,
      `UnguardedFix`, `unguarded` list, `totals.unguarded`; `SummonLabel` unchanged
    - Tests (`test/select-candidates.test.ts`): the 50-commit trigger (50 → diff-review,
      51 with 3+ matches → message), the fewer-than-3-matches trigger, rule lists,
      newest-first order, and that the confirmation loop's `maxLlmChecks` and `limit` caps
      apply to diff-review Candidates (with `unchecked` counted)
    - _Requirements: 2.8, 2.9, 11.7, 11.8_
  - [x] 8.1 `src/summon/baseline.ts`: baseline run with cleanup in `finally`, failure reason
    plus hints for `.gitmodules`, `filter=lfs` and ignored `.env*`; tests for each hint
    - _Requirements: 8.5, 8.6_
  - [x] 8.2 `src/summon/summon-one.ts` (no reruns yet): early `lost` for
    `no source files to revert` and `fix changes dependencies` (link plan only), worktree,
    deps, apply, tests, `internal error`; tests for every label and reason using
    `node check.mjs`
    - _Requirements: 4.5, 4.6, 5.1–5.8, 10.1, 10.2, 10.4, 10.5_
  - [x] 8.3 `src/report/verify.ts` and totals: SHA verification for entries, `rejected`,
    `llmErrors`, `unguarded` and `baseSha`; entry-derived totals, `unguarded` total from
    its list, and phase totals as in the design
    - _Requirements: 11.2, 11.4_
  - [x] 8.4 `src/repo/test-suite.ts` (`hasTestSuite` from `git show <base>:package.json`:
    missing file, missing / empty / non-string `scripts.test`, or `no test specified` means
    no test suite; invalid JSON counts as a test suite) and `src/resurrect.ts`: the run
    order from the design (validate, scan, `selectCandidates`, test-suite check only when
    the caller did not set `testCommand`, early return with `ok` or `no-tests`, LLM env,
    then either deps plan, baseline, confirm and summon, or for `no-tests` confirm and fill
    `unguarded` with no worktree; verify, redact) without the optional steps;
    `src/index.ts` exports
    - _Requirements: 2–11, 13_
  - [x] 8.5 `test/resurrect.test.ts`: end-to-end cases from the design's testing strategy,
    including baseline-failed with zero LLM calls, and a repo with no test script: status
    `no-tests`, no worktree created (`git worktree list` shows only the main tree during
    and after), Confirmed fixes in `unguarded` with verified SHAs, `entries` empty; plus
    the same repo with an explicit `testCommand` running normally. Fake LLM scripted per
    commit, since small generated repos run in diff-review mode
    - _Requirements: 2–11_

- [x] 9. Checkpoint: `npm run build` and `npm test` pass on Windows

- [x] 10. Real-repo check script
  - [x] 10.1 Add dev dep `tsx`; engine script `summon` (`tsx scripts/summon.ts`) and root
    script `summon` (`npm run summon -w @hades/engine --`)
    - _Requirements: 14.1_
  - [x] 10.2 `scripts/summon.ts`: parse `<absolute repo path> [--limit N]` with
    `node:util` `parseArgs`; call `resurrect()` with the real LLM client; print the
    summary (totals, then label, short SHA, message, files reverted and lost reason per
    entry; baseline reason and excerpt when `baseline-failed`; for `no-tests` the line
    `No test suite. N past fixes are unguarded.`); write the full JSON report
    to `~/.hades/reports/<name>-<short sha>-<timestamp>.json`, refusing a path inside the
    target Repo; print the report path; exit 0 for `ok` and `no-tests`, 2 for
    `baseline-failed`, 1 on error; print the Ctrl+C note at start
    - _Requirements: 14.2, 14.3, 14.4, 14.5, 9_
  - [x] 10.3 Ctrl+C recovery in `scripts/summon.ts`: a `SIGINT` handler in the script (not
    the engine) that runs `git worktree list --porcelain`, finds worktrees locked with
    `hades pid=<process.pid>`, and prints, with the real paths filled in and in this order:
    (1) only if `<worktree>/node_modules` is a link, remove the link first, before any git
    command: Windows `cmd /c rmdir "<worktree>\node_modules"` (no `/s`), POSIX
    `rm "<worktree>/node_modules"` (no `-r`); (2) `git -C "<repo>" worktree unlock
    "<worktree>"`; (3) `git -C "<repo>" worktree remove --force "<worktree>"`. It prints
    only, runs none of them, and exits 130. Test the printing function with a locked
    worktree and a linked `node_modules`, and check the command order
    - _Requirements: 14.7_

- [x] 11. Script options and a narrower dependency check (tasks 1–10 stay done)
  - [x] 11.1 `scripts/summon.ts`: add `--test-command "<cmd>"` and `--timeout <seconds>`
    to the argument parser, exported as a pure `parseSummonArgs(argv)`; pass them to
    `resurrect()` as `testCommand` and `timeoutMs` (seconds × 1000), leaving them out when
    not given; print `test command: <redacted command>` (with `(default)` when not given,
    or `none (no test script in package.json)` for `no-tests`) and the timeout in the
    summary header. Tests (`test/summon-args.test.ts`): both options parsed and converted,
    combined with `--limit`, absent options left undefined; empty command, `0`, negative,
    non-integer and non-numeric timeouts, and unknown options rejected with exit code 1
    before `resurrect()` is called
    - _Requirements: 14.1, 14.3_
  - [x] 11.2 `src/history/dependency-change.ts`: `changesDependencies(repo, sha,
    nonTestPaths)`: lockfiles always count; a `package.json` counts only if
    `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` or
    `bundleDependencies` differ between `git show <sha>^:<path>` and `git show <sha>:<path>`
    (deep comparison of parsed JSON); a missing side, invalid JSON or a non-object counts.
    Use it in `src/summon/summon-one.ts` in place of the `isDependencyFile` check (link plan
    only). Tests (`test/dependency-change.test.ts` and a `summon-one` case each): a
    version-only `package.json` bump is summoned and `package.json` is in
    `filesReverted`; a `dependencies` change is `lost` `fix changes dependencies`; an
    invalid-JSON `package.json` is `lost` `fix changes dependencies`; a lockfile change is
    `lost`; with an `install` plan, the dependency change is summoned as before
    - _Requirements: 4.6, 4.7, 4.8_

- [x] 12. Checkpoint: real-repo check. Clone a real JS/TS repo outside the Hades repo (never
  committed), run `npm install` in it, set the `HADES_LLM_*` variables, and run
  `npm run summon -- <path> --limit N`. Passes when the summary shows at least one
  `escaped` entry and `git status` in the target repo is unchanged. Record the repo URL,
  base SHA and totals in the task notes
  - _Notes (recorded by user): repo iamkun/dayjs @ d3e43be; test command `E:\demo\dayjs-tests.cmd` (jest with the one DST test skipped); totals 20 processed / 8 escaped / 7 buried / 5 lost_
  - _Requirements: 14.6, 5.6_

- [x] 13. Property tests
  - [x] 13.1 `test/helpers/arbitraries.ts`: generators for file trees, mixed fix commits,
    later conflicting commits, extra patterns
  - [x] 13.2 `test/properties.test.ts`, git-backed properties run 5 times by default and 20
    when `HADES_PROPERTY_RUNS=20` (`npm run test:props:full`):
    1. Real working tree unchanged (including `lost` and `baseline-failed`)
    2. reverse-apply then re-apply restores exact bytes
    3. no test or non-code file in `filesReverted`; every reverted path is in the Fix diff
    4. every reported SHA exists
    5. no leftover worktrees or temp folders; `node_modules/marker.txt` intact
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
    - Measured on Windows: default run (5 runs) 73 s; `npm run test:props:full` (20 runs) 271 s.

- [x] 14. Engine README
  - [x] 14.1 `packages/engine/README.md`: what summoning does, `resurrect()` and
    `npm run summon` usage, every option with its default, LLM env variables, the labels
    and lost reasons, and the trust warning: summoning runs the Repo's own test scripts and
    `installCommand` runs install scripts, so only use it on repos you trust
    - _Requirements: 1.8_

- [x] 15. Checkpoint: `npm install`, `npm run build` and `npm test` pass from a clean clone on
  Windows; `git status` in the Hades repo shows no stray files

- [x] 16. Optional hardening (only after task 12 passes)
  - [x] 16.1 AbortSignal support: `ResurrectDeps.signal`, `HadesAbortError`, signal
    params on `runGit`, `runCommand` (kill tree on abort) and the LLM client (combined with
    the 30 s timeout, no `AbortSignal.any`); `throwIfAborted()` between phases and fixes.
    `createWorktree` never takes the signal; callers call `throwIfAborted()` right after it,
    inside the `try` whose `finally` removes the worktree. Tests: abort during a test run,
    during install, and right after worktree creation; add aborted runs to properties 1
    and 5
    - _Requirements: 7.1, 7.2, 12.5_
  - [x] 16.2 Stale cleanup at run start (`src/summon/stale.ts`): parse
    `git worktree list --porcelain`; remove only locked `hades-summon-*` worktrees inside
    `os.tmpdir()` whose `hades pid=<pid>` names a dead process (`process.kill(pid, 0)`
    throws `ESRCH`), via unlock + `removeWorktree`; never remove unlocked ones, live-pid ones
    or non-Hades locks; fill `totals.staleCleaned`. Tests with a dead pid, the current pid,
    an unlocked `hades-summon-*` worktree and a non-Hades locked worktree
    - _Requirements: 7.3, 7.4, 7.5_
  - [x] 16.3 Workspace-repo detection in `deps-plan.ts`: `workspaces` field,
    `pnpm-workspace.yaml`, or a `node_modules` symlink resolving inside the Repo (top level
    and `@scope/`); install when `installCommand` is set, otherwise link and add the exact
    warning text; tests for each detection rule and both plan rows
    - _Requirements: 6.1, 6.3, 6.4_
  - [x] 16.4 `rerunOnFail` (0–3) in config and `summon-one.ts`: rerun on non-zero exit;
    any passing rerun → `lost` `flaky tests`, otherwise `buried`; rerun timeout counts as a
    failed rerun; excerpt from the first failing run; `runs` count. Tests with the flaky
    `check.mjs` variant
    - _Requirements: 8.7, 10.2, 10.3, 13.1_

- [ ]* 17. Optional: run the spike (task 1.2–1.3) and the full suite on Linux, on the Linux
  VM or in a GitHub Actions `ubuntu-latest` job; record the git version and results in the
  "Spike result" section of `design.md`
  - _Requirements: 5.3, 5.4_

## Notes

- Never modify the user's real working tree. Summoning happens only in temporary worktrees,
  and test files are never reverted.
- The Windows spike (task 1) decides between `git apply -R --3way` and the fallback. Tasks
  5.x to 7.4 follow that result.
- Task 12 uses a real repo cloned outside the Hades repo. Never commit it. Record its URL,
  base SHA and totals here when done.
- Tasks marked `*` (16 and 17) are optional and start only after task 12 passes.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3"] },
    { "id": 3, "tasks": ["4", "5"] },
    { "id": 4, "tasks": ["6"] },
    { "id": 5, "tasks": ["7"] },
    { "id": 6, "tasks": ["8"] },
    { "id": 7, "tasks": ["9"] },
    { "id": 8, "tasks": ["10", "13"] },
    { "id": 9, "tasks": ["11"] },
    { "id": 10, "tasks": ["12"] },
    { "id": 11, "tasks": ["14"] },
    { "id": 12, "tasks": ["15"] },
    { "id": 13, "tasks": ["16", "17"] }
  ]
}
```
