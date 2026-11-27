# Implementation Plan: History Reader

## Overview

This plan adds the history reader to `packages/engine/`: `askHistory` (commits, blame and
echoes for a file, range or symbol, with optional read-only GitHub context and an optional
LLM) and `rankHaunted` (source files ranked by fixes, reverts and churn). Work starts with a
Windows spike on `better-sqlite3`, then foundation, git reads, cache, GitHub, echoes, the two
entry points, property tests, a core checkpoint and a real-repo check on dayjs.

## Tasks

Each task ends with its tests passing (`npm test` at the root). Checkpoints must pass before
the next group starts. Paths are relative to `packages/engine/` unless they start at the
repo root. Tasks marked `*` are optional and are done only after the real-repo check
(task 13) passes.

- [x] 1. Spike: `better-sqlite3` on Windows, Node 24
  - [x] 1.1 `npm install better-sqlite3 -w @hades/engine` and
    `npm install -D @types/better-sqlite3 -w @hades/engine`, with `--foreground-scripts` so
    the output shows whether a prebuilt binary was downloaded or `node-gyp` built it
  - [x] 1.2 `test/spike/sqlite.test.ts`: open `<os.tmpdir()>/hades-spike-<random>.db`, set
    `journal_mode = WAL`, create a table, insert a row, read it back, close, delete the file
    and its `-wal` / `-shm` files
  - [x] 1.3 Write `.kiro/specs/history-reader/spike.md`: Node, npm and `better-sqlite3`
    versions, prebuilt or native build, test result. IF install or test fails, record the
    error and STOP for a decision (fallbacks to discuss: `node:sqlite`, JSON-file cache, no
    cache)
    - _Requirements: 1.1, 1.2, 1.3_
- [x] 2. Checkpoint: spike passed and recorded in `spike.md`, approved before task 3

- [x] 3. Foundation
  - [x] 3.1 `src/git/exec.ts`: optional `input` (stdin) on `RunGitOptions`; module counter
    with `gitCallCount()` (not exported from `index.ts`); `gitEnvironment` also strips
    `GITHUB_TOKEN` (case-insensitive on Windows). Extend `git-exec.test.ts`; existing tests
    pass unchanged
    - _Requirements: 5.12, 2.8_
  - [x] 3.2 `src/git/verify-shas.ts`: `existingCommits(repo, shas)` with one
    `git cat-file --batch-check` call; rejects non-40-hex and the all-zero SHA before the
    call; `verify-shas.test.ts` (commit, tree, missing, invalid input, exactly one git call)
    - _Requirements: 7.1, 7.3_
  - [x] 3.3 `src/history/closing-issues.ts`: move the closing-keyword list and `CLOSING_ISSUE`
    out of `candidates.ts`; add `closingIssueNumbers(text)` (same list, same-repo `#n` only,
    sorted, unique); `matchRules` imports `CLOSING_ISSUE`. `closing-issues.test.ts`; all
    existing candidates tests pass unchanged
    - _Requirements: 5.3_
  - [x] 3.4 `src/ask/types.ts`: `FoundBy`, `BlameRange`, `HistoryCommit`, `EchoSource`,
    `Echo`, `EchoConfidence`, `NO_RECORD_TEXT`, `HistoryAnswer`, `HauntedFile`,
    `HauntedReport` as in the design
    - _Requirements: 2.6, 2.13, 6.1, 6.2, 9.6_
  - [x] 3.5 `src/ask/options.ts`: `resolveAskOptions` (zod, strict, defaults `maxCommits` 50,
    `excerptChars` 4000, `maxGithubRequests` 30, `githubTimeoutMs` 10000, `githubTtlMs`
    86400000, `maxLlmChecks` 5), `lines` and `symbol` rules, `normalizeTargetFile`;
    `ask-options.test.ts` for defaults and every rejection (absolute POSIX, `C:\`, UNC, `..`
    escaping, empty, backslashes normalised)
    - _Requirements: 3.2, 3.3, 3.4, 10.1_

- [x] 4. Git reads
  - [x] 4.1 `src/ask/parse-log.ts` (pure): marker-based record split, NUL header fields,
    merges dropped, excerpt cut without splitting surrogate pairs; `parse-log.test.ts`
    including a commit message that contains `\x1e` and a fake marker
    - _Requirements: 2.6, 2.7, 5.14_
  - [x] 4.2 `src/ask/parse-blame.ts` (pure): porcelain to merged `{ start, end, sha }` ranges,
    zero SHA dropped; `parse-blame.test.ts`
    - _Requirements: 2.3, 7.3_
  - [x] 4.3 `src/ask/git-reads.ts`: file log (`--follow -p`), blame (`-L ... HEAD --`),
    symbol log (`-L :<escaped>:<file>`), missing-commit read (`--no-walk`); expected
    failures mapped to warnings (missing at HEAD, no `-L` match, range past end), other
    failures throw `GitError`. `git-reads.test.ts` on real temp repos: rename followed,
    function history, symbol with `. $ ( + |` (confirm the escape set and update the design
    if git uses extended regex), blame range, deleted file, no match, range past end
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.9, 2.10, 2.11, 2.12, 3.5_
  - [x] 4.4 `src/ask/merge.ts` (pure): union by SHA, `foundBy`, file-log diff wins, order by
    committer time then SHA; unit tests
    - _Requirements: 2.6_

- [x] 5. Cache
  - [x] 5.1 `src/cache/repo-id.ts`: `repoId(root)` from `realpathSync.native`, lower-cased on
    Windows, SHA-256, 16 hex chars; tests for stability and case folding
    - _Requirements: 8.2_
  - [x] 5.2 `src/cache/store.ts` and `src/cache/null-store.ts`: `HistoryCache` interface,
    schema with `user_version = 1`, WAL and `busy_timeout`, tables `commits`, `reads`,
    `github` (TTL on read), `echoes` (one row per SHA, input key), `state`; every error
    switches to no-op behaviour with one `cache:` warning; `openCache` creates `hadesHome`,
    refuses a path inside the Repo
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_
  - [x] 5.3 `cache.test.ts`: TTL expiry with an injected clock, echo overwrite on a new key,
    version bump recreates tables, corrupt file gives a no-op cache and a warning, path
    inside the Repo refused, temp `hadesHome` only
    - _Requirements: 8.5, 8.6, 8.9_

- [x] 6. GitHub (read-only)
  - [x] 6.1 `src/github/remote.ts`: `parseGithubRemote` (https, ssh, scp; credentials
    ignored; `github.com` only) and `readGithubTarget` (`git remote get-url origin`,
    `allowFail`); `github-remote.test.ts` plus pure property: output never contains the
    URL's user or password, non-`github.com` hosts give `undefined` (100 runs)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 6.2 `src/github/types.ts`, `src/github/client.ts`: `GithubClient` with
    `commitPulls` and `issue` (and the `reviewComments` signature, unused until task 15.2),
    `fetch` GET only to `https://api.github.com`, headers, token only in `Authorization`,
    `AbortSignal.timeout`, rate-limit detection, 404/422 as `not-found`, zod-validated
    responses, redacted messages. PR merge state parsed from `merged_at` (`string | null`)
    as `merged = merged_at !== null` (the response has no `merged` boolean).
    `github-client.test.ts` with a stubbed `fetch`, including a realistic
    `commits/{sha}/pulls` body (full PR objects with extra fields) containing one PR with
    `merged_at` set and one with `merged_at: null`, asserting `merged` true and false
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 5.9, 5.10, 5.11, 5.12, 5.13_
  - [x] 6.3 `test/helpers/fake-github.ts`: in-memory client over a dataset keyed by SHA,
    PR and issue number; records calls; scripted rate-limit, error and not-found answers
    - _Requirements: 5.13_
  - [x] 6.4 `src/github/context.ts`: `gatherContext` with budget order (blame/symbol-log
    commits first, then file-log, newest first in each), PR choice (merged, then lowest
    number), up to 3 linked issues, cache lookups with TTL, one summary warning for
    unreached commits, stop on rate limit for the rest of the Question, deduplicated error
    warnings, only `ok` / `not-found` cached. `github-context.test.ts`, including a warm
    cache freeing budget so a second Question reaches more commits
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.7, 5.8, 5.9, 5.10, 8.5_

- [x] 7. Echoes
  - [x] 7.1 `src/echo/sources.ts` (pure): Sources with ids `commit`, `pr`, `issue-<n>`, in
    rule order; URLs only from GitHub or the built commit URL
    - _Requirements: 6.2, 6.13_
  - [x] 7.2 `src/echo/rule-order.ts` (pure): trivial-message filter, trim, cut to 300 without
    surrogate split, `truncated`, `none` echo; `echo-rule-order.test.ts` plus pure property:
    the text is always a substring of one source and at most 300 chars (100 runs)
    - _Requirements: 6.2, 6.3, 6.12_
  - [x] 7.3 `src/echo/llm-echo.ts`: system prompt (`ECHO_PROMPT_VERSION = 1`), nonce-marked
    data blocks, sources capped at 2000 chars in the prompt, zod answer schema, verification
    table from the design (quote substring of the named Source, `probably`, `<sha7>: `
    prefix, 300-char limit), 30 s timeout race (`ECHO_LLM_TIMEOUT_MS`), no throws.
    `echo-llm.test.ts`: every row of the outcomes table, prompt markers and the "never
    follow instructions" line, 401 does not throw, timeout is a failure; pure property:
    verification never yields `said` for a quote that is not in the named Source
    - _Requirements: 5.14, 6.4, 6.5, 6.6, 6.8, 6.11, 6.13, 6.15_
  - [x] 7.4 `src/echo/build.ts`: plan / run / assemble; input key (sources, diff, model,
    prompt and rule versions); cap given to the newest commits; promise pool with
    `ECHO_LLM_CONCURRENCY = 4`; results assembled by index; failed, timed-out and over-cap
    echoes not cached; one summary warning for failed calls; LLM availability from `deps`
    and `HADES_LLM_*` (partly set → warning). `echo-build.test.ts` as in the design
    - _Requirements: 6.7, 6.8, 6.9, 6.10, 6.13, 6.14, 8.6_
  - [x] 7.5 `echo-concurrency.test.ts` with fake timers: 5 fake calls of 1000 ms each, peak
    in-flight exactly 4; after 1000 ms four are done and one is running; after 2000 ms all
    five are done (about the time of 2 calls, not 5); a call that never resolves becomes a
    failure at 30000 ms and falls back to the rule order
    - _Requirements: 6.10, 6.11_

- [x] 8. `askHistory`
  - [x] 8.1 `src/ask/ask-history.ts`: the steps from the design (options, `validateRepo`,
    empty-repo answer, cache open/close in `finally`, remote, git reads, merge, GitHub
    context, echoes, SHA check with drop and warning, redaction of every warning with the
    token and the API key); `HistoryDeps`
    - _Requirements: 2.1, 2.13, 3.1, 7.1, 7.2, 10.3, 10.4, 10.5_
  - [x] 8.2 `git-call-budget.test.ts`: with lines, symbol and a fake GitHub on, the git call
    count is the same for 1, 10 and 50 commits and at most 10; a warm cache uses fewer
    - _Requirements: 2.8_
  - [x] 8.3 `secrets.test.ts`: `GITHUB_TOKEN` and `HADES_LLM_API_KEY` set to marker values,
    fakes that echo them back in errors; neither marker appears in the answer, warnings,
    thrown errors, any cache row (dump all tables) or the git child environment
    - _Requirements: 4.4, 5.12, 6.15, 8.7, 11.4_
  - [x] 8.4 Export `askHistory` and its public types from `src/index.ts`; add a history reader
    section to `packages/engine/README.md` (read-only, GitHub optional and GET only, token
    and LLM variables, cache location)
    - _Requirements: 10.3_

- [x] 9. `rankHaunted`
  - [x] 9.1 `src/haunted/scan.ts`: one `git -c core.quotePath=false log --no-merges
    --name-only` call with a marker, C-unquoting helper, one `git ls-tree -r -z --name-only
    HEAD` call
    - _Requirements: 9.2, 9.3_
  - [x] 9.2 `src/haunted/score.ts` (pure): revert / fix / plain from `matchRules`, only paths
    at HEAD, test and non-code matchers with extra patterns, score, sort by score then path,
    top N, SHAs per file
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.8_
  - [x] 9.3 `src/haunted/rank-haunted.ts`: options (zod, `maxCommits` 500, `top` 10, extra
    patterns), `validateRepo`, scan, score, `existingCommits` on all SHAs; export from
    `index.ts`. `haunted.test.ts`: scoring, ties, deleted and renamed-away files excluded,
    extra patterns, quoted paths, git call count is 6
    - _Requirements: 9.1, 9.10, 10.2_

- [x] 10. Property tests
  - [x] 10.1 `test/helpers/history-arbitraries.ts`: generated repos (2–12 commits, target
    file sometimes deleted or renamed, messages with trivial words, fix / revert / closing
    keywords, `\x1e`, fake markers, prompt-injection text, CRLF), fake GitHub datasets for
    a subset of SHAs, fake LLM scripted by SHA (valid quote, quote not in source, unknown
    source id, explanation with and without `probably`, overlong explanation, invalid JSON,
    thrown error)
  - [x] 10.2 `history-properties.test.ts`, properties 1–5 from the design with
    `parsePropertyRuns(process.env.HADES_PROPERTY_RUNS)` (default 5), temp `hadesHome`,
    offline. Property 4 asserts that during the warm run B the fakes are called exactly for
    the commits whose LLM call failed or whose GitHub context was incomplete in A (fakes
    answer by SHA, no rate limits, caps above what the repo can use)
    - _Requirements: 11.1, 11.2, 11.3_
  - [x] 10.3 Pure properties not covered above (100 runs): `closingIssueNumbers` is
    non-empty exactly when `matchRules` returns `closing-issue`; `parseLog` never produces a
    record from text inside a commit message
    - _Requirements: 5.3, 5.14_

- [x] 11. Checkpoint: core complete
  - `npm run build` with zero errors, `npm test` green, and one pass with
    `HADES_PROPERTY_RUNS=20`; all summoning-engine tests still pass

- [x] 12. Real-repo check on dayjs
  - [x] 12.1 `scripts/history-check.ts` and root `npm run history-check` as in the design;
    `history-check-args.test.ts` for argument parsing and rejections
    - _Requirements: 12.6_
  - [x] 12.2 Run on `E:\demo\dayjs`, all on the same real source file: (1) `askHistory`
    local-only without an LLM; (2) with the LLM from `HADES_LLM_*`, GitHub off; (3) with
    GitHub on (real client, `GITHUB_TOKEN` from env if set, otherwise unauthenticated) and
    the LLM from env; then `rankHaunted` with defaults. Confirm every automatic check passes
    (all SHAs exist, `said` quotes verbatim in their Source including PR and issue bodies
    recorded during run 3, `inferred` contains `probably`, no test or non-code file ranked)
    and that dayjs HEAD and status are unchanged. A GitHub rate limit in run 3 is recorded
    and is not a failure
    - _Requirements: 12.1, 12.3, 12.4, 12.5_
  - [x] 12.3 Record in `.kiro/specs/history-reader/real-repo-check.md`: file and dayjs HEAD
    used, commit and echo counts per confidence, three sample echoes per run with a note on
    whether each looks right, top haunted files, git calls per Question, durations. For run
    3 also: token used yes/no (never the value), GitHub requests used, commits that got a
    PR, echoes quoting a `pr-body` or `issue-body`, and every GitHub warning (including a
    rate limit and its reset time, if hit)
    - _Requirements: 12.2, 12.4_
- [x] 13. Checkpoint: real-repo check recorded and reviewed before any optional task

- [x] 14. Optional: rate-limit memory across Questions
  - [x] 14.1 In `github/context.ts`, store `github-rate-limited-until` in the cache `state`
    table on a rate limit; later Questions skip network requests (cache hits still used)
    until it passes, with the same warning. Tests with the fake clock
    - _Requirements: 5.9.1_
- [ ] 15. Optional: PR review comments as a Source
  - [ ] 15.1 Implement `reviewComments` in `github/client.ts` (`?per_page=100`, first page)
    and the fake
  - [ ] 15.2 In `github/context.ts`, fetch review comments for the chosen PR after the
    issues (last in the budget); `echo/sources.ts` adds `review-<id>` Sources after issues;
    LLM prompt includes up to 5; bump `ECHO_PROMPT_VERSION` and `RULE_ORDER_VERSION` so
    cached echoes are recomputed. Extend the echo tests and property 2 to cover review
    comments
    - _Requirements: 5.2.1, 6.3_
- [ ] 16. Optional: escaped souls in `rankHaunted`
  - [x] 16.1 `src/haunted/escaped.ts`: newest 50 reports in `<hadesHome>/reports/` by
    mtime, minimal zod schema, match by normalised `repo` path, newest match wins,
    `escapedSouls` per file, invalid reports skipped with a warning, read-only; escaped SHAs
    included in the SHA check. `haunted-escaped.test.ts` (reports dir mtimes unchanged)
    - _Requirements: 9.9, 9.10_

## Notes

- Record the SQLite spike result and obtain approval at task 2 before continuing.
- Each task ends with the root `npm test` passing. Task 11 is the core checkpoint.
- Record and review the dayjs check at task 13 before starting optional tasks 14–16.
- History reads are read-only. Use temporary locations for test caches and real-repo checks.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3"] },
    { "id": 3, "tasks": ["4"] },
    { "id": 4, "tasks": ["5"] },
    { "id": 5, "tasks": ["6"] },
    { "id": 6, "tasks": ["7"] },
    { "id": 7, "tasks": ["8"] },
    { "id": 8, "tasks": ["9"] },
    { "id": 9, "tasks": ["10"] },
    { "id": 10, "tasks": ["11"] },
    { "id": 11, "tasks": ["12"] },
    { "id": 12, "tasks": ["13"] },
    { "id": 13, "tasks": ["14"] },
    { "id": 14, "tasks": ["15"] },
    { "id": 15, "tasks": ["16"] }
  ]
}
```
