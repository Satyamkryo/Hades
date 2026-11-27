# Requirements Document

## Introduction

This document specifies the History Reader.

The history reader lives in `packages/engine`, next to the summoning engine. It answers two
questions for later features (the reviewer, the MCP tool `ask_history`, Cerberus):

- **Why does this code look like this?** `askHistory(repo, file, { lines?, symbol? })` returns
  the commits that touched a file, a line range or a symbol, and an **echo** for each commit:
  history evidence with a confidence of `said`, `inferred` or `none`.
- **Where do bugs live?** `rankHaunted(repo, { maxCommits, top })` ranks source files by past
  fixes, reverts and churn, so pushed and PR reviews look at the riskiest files first.

GitHub context (pull requests, review comments, linked issues) is optional and read-only.
Results are cached in a SQLite file under `~/.hades/`, outside the repo.

The history reader only reads. It never changes the Repo, never writes to GitHub, and never
cites a SHA that does not exist.

Criteria marked **(optional)** are built after the real-repo check (Requirement 12) passes.
Until then the engine works without them.

### Reused from the summoning engine

| Piece | Location | Used for |
| --- | --- | --- |
| `runGit` | `src/git/exec.ts` | every git call |
| `scanCommits`, `CommitInfo` | `src/history/scan.ts` | commit message reads where its format fits |
| `matchRules` | `src/history/candidates.ts` | fix / revert detection in `rankHaunted` |
| closing-keyword list | `src/history/candidates.ts` (`CLOSING_ISSUE`) | linked issues (one shared definition) |
| `makeTestFileMatcher`, `makeNonCodeMatcher` | `src/classify/files.ts` | excluding files from `rankHaunted` |
| `redact()` | `src/report/redact.ts` | removing the GitHub token and LLM key |
| `HadesConfigError` | `src/errors.ts` | invalid input |
| `readLlmEnv`, `createOpenAiCompatibleClient`, `LlmClient` | `src/llm/` | inferred echoes |
| `validateRepo` | `src/repo/validate.ts` | repo checks |
| `parsePropertyRuns` (`HADES_PROPERTY_RUNS`) | `test/helpers/property-runs.ts` | property test run counts |

## Glossary

- **Repo**: the user's git repository, given as an absolute path.
- **Repo root**: the top-level folder of the Repo's working tree (`git rev-parse --show-toplevel`).
- **Target file**: the repo-relative path passed to `askHistory`.
- **Question**: one `askHistory` call.
- **History commit**: a commit returned by a Question.
- **Echo**: history evidence for one History commit (Requirement 6).
- **Source**: a text an echo can quote: a commit message, PR body, PR review comment or
  issue body.
- **GitHub mode**: the Repo's `origin` remote points at `github.com`. Otherwise the Repo is in
  **local-only mode**.
- **Repo id**: a short hash identifying the Repo for the cache (Requirement 8.2).
- **Haunted file**: a source file ranked by `rankHaunted`.
- **Test file**, **Non-code file**: as defined by the summoning engine's matchers
  (summoning-engine Requirement 4.1 and 4.2).

## Requirements

### Requirement 1: Cache backend spike

**User Story:** As a Hades developer, I want to know that `better-sqlite3` builds and runs on
this machine before anything depends on it, so a native build failure does not block the
feature halfway through.

#### Acceptance criteria

1. THE first implementation task SHALL install `better-sqlite3` as a dependency of
   `packages/engine` on the development machine (Windows, Node 24, current npm) and run a
   script or test that creates a database file in the OS temp directory, creates a table,
   writes a row, reads it back, closes the database and deletes the file.
2. THE spike SHALL record in `.kiro/specs/history-reader/spike.md`: the Node, npm and
   `better-sqlite3` versions, whether a prebuilt binary was used or a native build ran, and
   the result.
3. IF the install or the open/write/read fails, THEN work SHALL stop after recording the
   failure, and SHALL NOT continue until the user decides how to proceed.

### Requirement 2: Ask the history of a file

**User Story:** As a reviewer (later, the MCP tool `ask_history`), I want the commits that
touched a file, a line range or a symbol, so every omen can point at real history.

#### Acceptance criteria

1. THE engine SHALL export `askHistory(repo, file, options?)` where `options` may contain
   `lines?: [start, end]`, `symbol?: string`, and the options in Requirement 10.
2. THE engine SHALL read file history with `git log --follow` for the Target file, at HEAD,
   newest first, limited to `maxCommits` commits.
3. WHEN `lines` is given, THE engine SHALL also run `git blame --porcelain -L <start>,<end>
   HEAD -- <file>` and return, for each line range, the SHA that last changed it.
4. WHEN `symbol` is given, THE engine SHALL also run `git log -L :<symbol>:<file>` at HEAD,
   limited to `maxCommits` commits.
5. WHEN neither `lines` nor `symbol` is given, THE engine SHALL NOT run `git blame`.
6. THE engine SHALL return each History commit once, with: full SHA, full commit message,
   author name, author date (ISO 8601), a diff excerpt limited to the Target file, whether
   the excerpt was truncated, and which reads found it (`blame`, `file-log`, `symbol-log`).
7. THE diff excerpt SHALL be at most `excerptChars` characters (Requirement 10).
8. THE number of git processes a Question starts SHALL NOT depend on the number of commits.
   THE engine SHALL read each list of commits and its diffs in one `git log` call, not one
   call per commit. A Question SHALL start at most 10 git processes, including repo
   validation, remote detection and the SHA check (Requirement 7.1).
9. IF a SHA from blame is not in the `file-log` result (for example because of the
   `maxCommits` limit), THEN THE engine SHALL read all such SHAs in one extra `git log
   --no-walk` call.
10. THE engine SHALL blame HEAD, not the working tree, so uncommitted lines never produce the
    all-zero SHA. Line numbers refer to the file at HEAD.
11. IF the Target file does not exist at HEAD but has history, THEN THE engine SHALL skip
    blame, return the file log, and add a warning.
12. IF git reports no match for `symbol`, THEN THE engine SHALL return the other results and
    add a warning, and SHALL NOT throw.
13. THE result SHALL include the HEAD SHA it was computed at, the echoes (Requirement 6),
    the GitHub mode (Requirement 4.5), and a list of warnings.

### Requirement 3: Validate input

**User Story:** As a user, I want bad input rejected clearly, so a wrong path or symbol cannot
make Hades run unexpected git commands or read files outside the Repo.

#### Acceptance criteria

1. THE engine SHALL validate the Repo with `validateRepo` and SHALL throw `HadesConfigError`
   for an invalid Repo.
2. THE Target file SHALL be a relative path that stays inside the Repo root after
   normalisation. Absolute paths, `..` segments that leave the Repo, and empty paths SHALL
   throw `HadesConfigError`.
3. `lines` SHALL be two integers with `1 <= start <= end`. Anything else SHALL throw
   `HadesConfigError`.
4. `symbol` SHALL be a non-empty string of at most 200 characters with no `:`, newline or NUL
   character. Anything else SHALL throw `HadesConfigError`.
5. THE engine SHALL pass every value to git as a separate argument through `runGit`, never
   through a shell, and SHALL put the Target file after `--` wherever git accepts a pathspec.

### Requirement 4: Detect GitHub

**User Story:** As a user, I want Hades to find my GitHub repo on its own, and to keep working
without GitHub, so local repos and other hosts are first-class.

#### Acceptance criteria

1. THE engine SHALL read the `origin` remote URL with one git call.
2. THE engine SHALL be in GitHub mode IF the URL host is `github.com` (case-insensitive) in
   any of these forms: `https://github.com/<owner>/<repo>[.git]`,
   `git@github.com:<owner>/<repo>[.git]`, `ssh://git@github.com/<owner>/<repo>[.git]`.
3. IF there is no `origin` remote, or its host is anything else (including GitHub Enterprise
   hosts), THEN THE engine SHALL use local-only mode. This SHALL NOT be an error or a warning.
4. IF the remote URL contains credentials (for example `https://user:token@github.com/...`),
   THEN THE engine SHALL drop them and SHALL NEVER store, log or return them.
5. THE result SHALL state the mode and, in GitHub mode, `<owner>/<repo>`.

### Requirement 5: Read GitHub context

**User Story:** As a user, I want each commit linked to its pull request, review comments and
issues, so an echo can quote why a change was made.

#### Acceptance criteria

1. IN GitHub mode, FOR each History commit, THE engine SHALL find its pull requests with
   `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
2. THE engine SHALL take each pull request's number, URL, merge state and body from the
   `commits/{sha}/pulls` response (no separate request per PR). THE chosen pull request SHALL
   be a merged one first, then the lowest number.
   1. **(optional)** FOR the chosen pull request, THE engine SHALL read its review comments
      (`GET /repos/{owner}/{repo}/pulls/{number}/comments`, first page only, at most 100)
      and use them as Sources. Until this exists, review comments are not read and are not
      Sources.
3. THE engine SHALL find linked issues from closing keywords followed by `#<digits>` in PR
   bodies and commit messages, using the same keyword list as summoning (one shared
   definition in the engine, not a copy). Only same-repo references (`#123`) count.
4. FOR each linked issue, up to 3 per commit in ascending number order, THE engine SHALL
   read its body (`GET /repos/{owner}/{repo}/issues/{number}`).
5. THE engine SHALL only send GET requests to `https://api.github.com`. It SHALL NEVER send a
   request that writes to GitHub.
6. THE engine SHALL read the token from the environment variable `GITHUB_TOKEN` only. WITHOUT
   it, THE engine SHALL send unauthenticated requests.
7. THE engine SHALL make at most `maxGithubRequests` requests per Question (Requirement 10),
   counting cache hits as zero. THE engine SHALL spend this budget on History commits in this
   order: commits found by `blame` or `symbol-log` first, then the other `file-log` commits,
   newest first within each group.
8. History commits the budget does not reach SHALL get no GitHub context. THE engine SHALL
   add one summary warning with their count, not one warning per commit.
9. IF GitHub answers with a rate-limit response (HTTP 403 or 429 with
   `x-ratelimit-remaining: 0` or a `retry-after` header), THEN THE engine SHALL stop sending
   GitHub requests for the rest of the Question, add a warning that names the reset time if
   given, and return the results it has.
   1. **(optional)** THE engine SHALL remember the reset time in the cache, and later
      Questions SHALL skip GitHub network requests until it passes (cache hits still used),
      with the same warning.
10. IF a GitHub request fails for any other reason (network error, timeout, 401, 404, 5xx,
    invalid JSON), THEN THE engine SHALL add a warning and continue with the data it has. A
    GitHub failure SHALL NEVER make `askHistory` throw.
11. EVERY GitHub request SHALL have a timeout (default 10 seconds).
12. THE token SHALL NEVER appear in errors, warnings, logs, results or the cache. THE engine
    SHALL pass every warning and error message through `redact()` with the token, and SHALL
    remove `GITHUB_TOKEN` from the environment of git child processes.
13. THE GitHub client SHALL be injectable, so tests run offline with a fake.
14. THE engine SHALL treat every commit message, PR body, review comment and issue body as
    untrusted data: it SHALL store and quote the text, and SHALL NEVER follow instructions
    in it. WHEN such text is sent to the LLM, the prompt SHALL mark it as data inside clear
    delimiters and tell the model not to follow instructions in it.

### Requirement 6: Echoes

**User Story:** As a user, I want every History commit to come with evidence and an honest
confidence, so I can trust what Hades says and see when it is guessing.

#### Acceptance criteria

1. EACH History commit SHALL have exactly one echo:
   `{ sha, prNumber?, issueNumbers[], url?, confidence, text, source? }`, where `confidence`
   is `said`, `inferred` or `none`.
2. A `said` echo's `text` SHALL be a contiguous substring of one Source, at most 300
   characters, copied exactly (no whitespace or case changes). `source` SHALL record the
   Source kind (`commit-message`, `pr-body`, `review-comment`, `issue-body`), its identifier
   (SHA, PR number, comment id or issue number) and its URL when known. A cut-off quote SHALL
   set `truncated: true` and SHALL NOT add an ellipsis inside `text`.
3. **Rule order (no LLM).** THE engine SHALL choose the `said` quote deterministically, in
   this order: the commit message, then the PR body, then a linked issue body, then
   **(optional, with 5.2.1)** the first review comment. A Source SHALL be skipped IF it is empty, or IF it is a commit message
   whose trimmed text is shorter than 8 characters or is one of `wip`, `update`, `updates`,
   `changes`, `misc`, `fix`, `fixes`, `tmp` (case-insensitive). The quote SHALL be the first
   300 characters of the chosen Source. IF no Source qualifies, THEN the echo SHALL be `none`.
4. **LLM choice.** WHEN an LLM is configured, THE engine SHALL make one LLM call per History
   commit (within the cap in 6.9). The prompt SHALL contain the diff excerpt and every Source
   of that commit, each with an id, inside clear data delimiters (Requirement 5.14). THE
   engine SHALL request either `{ "quote": string, "source": <source id> }` or
   `{ "explanation": string }`, validated with zod.
5. WHEN the LLM returns a quote, THE engine SHALL make the echo `said` only IF the quote is at
   most 300 characters and is an exact contiguous substring of the Source with that id.
   OTHERWISE THE engine SHALL use the rule order in 6.3.
6. WHEN the LLM returns an explanation, THE engine SHALL check that it contains the word
   `probably` (whole word, case-insensitive). THE engine itself SHALL build the `inferred`
   text as `<sha7>: <explanation>`, where `<sha7>` is the first 7 characters of the commit's
   SHA, and the final text SHALL be at most 300 characters. IF either check fails, THEN the
   echo SHALL be `none`.
7. WHEN none of `HADES_LLM_BASE_URL`, `HADES_LLM_API_KEY`, `HADES_LLM_MODEL` is set and no LLM
   client is injected, THE engine SHALL use the rule order in 6.3 for every commit, without a
   warning. WHEN only some of them are set, THE engine SHALL add a warning naming the missing
   variable(s) and continue without the LLM.
8. IF an LLM call fails (any HTTP status, network error, timeout, invalid JSON, schema
   failure), THEN THE engine SHALL use the rule order in 6.3 for that commit and continue. THE
   engine SHALL add one summary warning with the number of failed calls. An LLM failure SHALL
   NEVER make `askHistory` throw.
9. THE engine SHALL make at most `maxLlmChecks` LLM calls per Question (Requirement 10).
   Commits beyond the cap SHALL use the rule order in 6.3. The cap SHALL go to commits in the
   result order (newest first).
10. THE engine SHALL run at most 4 echo LLM calls at the same time, and SHALL assemble the
    echoes in commit order, so the result does not depend on which call finishes first.
11. EACH echo LLM call SHALL have a 30-second timeout. A timeout SHALL be handled like any
    other LLM failure (6.8).
12. A `none` echo's `text` SHALL say that no record explains the change. THE engine SHALL
    NEVER invent a reason.
13. `prNumber`, `issueNumbers` and `url` SHALL only contain values returned by GitHub or found
    in a Source, never values made up by the LLM. A `source` id returned by the LLM SHALL only
    be used to look up one of the Sources the engine sent.
14. THE LLM client SHALL be injectable. THE engine SHALL reuse the summoning engine's
    `LlmClient` interface and environment reader.
15. THE LLM API key SHALL NEVER appear in errors, warnings, results or the cache.

### Requirement 7: SHA integrity

**User Story:** As a user, I want every SHA Hades cites to be real, so evidence can always be
checked.

#### Acceptance criteria

1. BEFORE returning, THE engine SHALL check that every SHA in the result (History commits,
   blame ranges, echoes) exists in the Repo as a commit, with at most one git call for all of
   them (for example `git cat-file --batch-check`). This call counts toward the limit in 2.8.
2. IF a SHA fails the check, THEN THE engine SHALL drop the items that cite it and add a
   warning.
3. THE engine SHALL NEVER return the all-zero SHA.

### Requirement 8: Cache

**User Story:** As a user, I want repeated questions to be fast and to spare the GitHub rate
limit, without Hades writing anything into my repo.

#### Acceptance criteria

1. THE engine SHALL store the cache in a `better-sqlite3` database at
   `~/.hades/<repo-id>.db`, creating `~/.hades/` if needed. THE engine SHALL refuse to use a
   cache path inside the Repo.
2. THE Repo id SHALL be the first 16 hex characters of the SHA-256 of the Repo root's real
   path (`fs.realpathSync.native`), lower-cased on Windows, so one Repo always maps to one
   file.
3. Commit data (message, author, date) SHALL be keyed by SHA and SHALL never expire.
4. Results that depend only on commits (file log and symbol log with their diff excerpts,
   and blame, for a given HEAD SHA, file, range, symbol and limits) MAY be cached by those
   inputs and SHALL never expire.
5. GitHub data, including "no pull requests" and "not found" answers, SHALL be cached with a
   TTL of `githubTtlMs` (default 24 hours). Expired entries SHALL be re-fetched. Results cut
   short by a rate limit or an error SHALL NOT be cached as complete.
6. Echoes SHALL be cached by a key built from all their inputs: SHA, the Source texts, the LLM
   model name and a prompt version. WHEN any input changes, THE engine SHALL recompute the
   echo. Echoes that fell back to the rule order because an LLM call failed, or because the
   `maxLlmChecks` cap was reached, SHALL NOT be cached, so a later Question can still ask the
   LLM.
7. THE cache SHALL NEVER contain the GitHub token, the LLM API key or remote URL credentials.
8. THE clock and the cache directory SHALL be injectable for tests.
9. IF the cache cannot be opened or is corrupt, THEN THE engine SHALL continue without it and
   add a warning. A cache problem SHALL NEVER make a call fail.
10. A result read through the cache SHALL equal a fresh read with an empty cache, apart from
    warnings about the cache itself.

### Requirement 9: Haunted files

**User Story:** As a reviewer of pushed commits and PRs, I want the files with the most bug
history first, so the LLM budget goes where bugs have lived.

#### Acceptance criteria

1. THE engine SHALL export `rankHaunted(repo, { maxCommits?, top? })` with defaults
   `maxCommits` 500 and `top` 10.
2. THE engine SHALL read the newest `maxCommits` non-merge commits reachable from HEAD in one
   `git log --no-merges --name-only` call, with each commit's SHA and message.
3. THE engine SHALL read the paths that exist at HEAD in one `git ls-tree -r --name-only HEAD`
   call, and SHALL only rank those paths. Deleted files SHALL NEVER be listed.
4. FOR each path in the log output that exists at HEAD, excluding Test files and Non-code
   files (the summoning matchers, with the caller's `extraTestPatterns` and
   `extraNonCodePatterns`), THE engine SHALL count:
   1. `reverts`: commits whose `matchRules` result contains `revert`;
   2. `fixes`: other commits whose `matchRules` result is not empty;
   3. `churn`: all commits that changed the path.
5. THE score SHALL be `3 * fixes + 2 * reverts + churn / 10`.
6. THE engine SHALL return the `top` files by score, highest first, ties broken by path in
   ascending order, each with its counts, score and the SHAs behind `fixes` and `reverts`.
7. Paths SHALL be counted as written in each commit; renames are not followed, so history
   under a file's old name does not count toward its current path.
8. THE engine SHALL NEVER list a Test file or a Non-code file.
9. **(optional)** IF a summoning report exists in `~/.hades/reports/` whose `repo` field has the same real
   path as the Repo root, THEN THE engine SHALL read the newest one and add to each file the
   SHAs of `escaped` entries whose `filesReverted` include it (optional field
   `escapedSouls`). THE engine SHALL only read reports, never change them. Unreadable or
   invalid reports SHALL be skipped with a warning.
10. Every SHA in the result SHALL pass the check in Requirement 7.

### Requirement 10: Configuration

**User Story:** As a caller (later, the MCP server), I want all settings as function options,
so the history reader has no hidden config sources.

#### Acceptance criteria

1. `askHistory` SHALL accept these options, all optional, with these defaults: `maxCommits`
   (50), `excerptChars` (4000), `maxGithubRequests` (30), `githubTimeoutMs` (10000),
   `githubTtlMs` (86400000), `maxLlmChecks` (5).
2. `rankHaunted` SHALL accept `maxCommits` (500), `top` (10), `extraTestPatterns` (none) and
   `extraNonCodePatterns` (none).
3. Dependencies (GitHub client, LLM client, cache directory, clock, environment) SHALL be
   passed in a separate `deps` argument, as `resurrect()` does.
4. THE engine SHALL NOT read Hades configuration from files in the Repo, and SHALL NOT write
   anything inside the Repo or `.kiro/`.
5. Secrets SHALL come only from environment variables: `GITHUB_TOKEN` and the `HADES_LLM_*`
   variables.

### Requirement 11: Property tests

**User Story:** As a Hades developer, I want the evidence guarantees proven by property tests
on generated repos, so they hold beyond a few examples.

#### Acceptance criteria

1. THE test suite SHALL include fast-check property tests on generated git repos in temp
   directories, with a fake GitHub client and a fake LLM client, checking:
   1. every echo's SHA exists in the Repo (`git cat-file -e <sha>^{commit}`);
   2. every `said` quote appears verbatim in its stated Source: the commit message read from
      git, or the fake GitHub data;
   3. every `inferred` echo contains `probably` and starts with its `<sha7>: ` prefix,
      including when the fake LLM returns explanations without `probably` (those echoes must
      become `none`) and quotes that are not in their Source (those must follow the rule
      order);
   4. with a fixed clock, answer A (empty cache), answer B (the same cache, now warm) and
      answer C (a new empty cache) are deep-equal once `cache:` warnings are removed; and
      during B the fake LLM and fake GitHub receive calls only for the commits whose LLM
      call failed or whose GitHub context was incomplete in A, which are deliberately not
      cached (8.5, design `echo/build.ts`). The test SHALL assert exactly that set of
      commits. The fakes SHALL answer the same way every time for the same commit and SHALL
      never answer with a rate limit, and `maxGithubRequests` and `maxLlmChecks` SHALL be
      large enough that neither cap is reached in this property (a warm cache frees budget,
      so B could reach commits A did not; those cases are unit tests with their own
      expectations);
   5. `rankHaunted` never lists a Test file, a Non-code file, or a path missing at HEAD.
2. THE number of runs SHALL come from `HADES_PROPERTY_RUNS` through the existing
   `parsePropertyRuns` helper (default 5).
3. THE property tests SHALL run offline and SHALL use a temp cache directory, never the real
   `~/.hades/`.
4. Unit tests SHALL also check that the token and API key never appear in results, warnings,
   errors or cache rows, and that a fake rate-limit response ends GitHub reads without
   throwing.

### Requirement 12: Real-repo check

**User Story:** As a Hades developer, I want to run the history reader on a real repo, so I
can see that echoes and rankings make sense outside generated test repos.

#### Acceptance criteria

1. AFTER the core (every criterion not marked optional) passes its tests, THE developer SHALL
   run, on the dayjs clone at `E:\demo\dayjs`:
   1. `askHistory` on one real source file, in local-only mode without an LLM
      (`deps.github: null`, `deps.llm: null`);
   2. the same Question with an LLM configured from the `HADES_LLM_*` variables, GitHub off;
   3. the same Question with GitHub on (the real client; `GITHUB_TOKEN` from the environment
      if set, otherwise unauthenticated) and the LLM from the `HADES_LLM_*` variables;
   4. `rankHaunted` with default options.
2. THE results SHALL be recorded in `.kiro/specs/history-reader/real-repo-check.md`: the file
   and dayjs HEAD SHA used, the number of commits and echoes per confidence, three sample
   echoes per run, the top haunted files, the git process count per Question, and the
   durations. FOR the GitHub run (12.1.3) it SHALL also record: whether a token was used
   (never the token itself), the GitHub requests used, how many commits got a PR, how many
   echoes quote a `pr-body` or an `issue-body` Source, and every GitHub warning.
3. THE check SHALL pass WHEN every SHA in all four results passes `git cat-file -e
   <sha>^{commit}` in the dayjs repo, every `said` quote is found verbatim in its Source
   (the commit message from git, or the PR or issue body as received from GitHub during the
   run), every `inferred` echo contains `probably`, no haunted file is a Test or Non-code
   file, and the developer has reviewed the sample echoes and judged them plausible.
4. IF the GitHub run hits the rate limit, THEN that SHALL be recorded (with the reset time if
   given) and the check SHALL continue. A rate limit SHALL NOT fail the check.
5. THE dayjs clone SHALL NOT be changed by the check (`git status --porcelain=v2` output and
   HEAD identical before and after), and SHALL NOT be committed to the Hades repo.
6. THE check SHALL be run with `npm run history-check -- <absolute repo path> <file>
   [--lines a,b] [--symbol name] [--no-llm] [--no-github]`, backed by
   `packages/engine/scripts/history-check.ts`, which prints the results above and writes the
   full JSON to `~/.hades/history/` (outside the target Repo, and not in `reports/`, which
   holds summoning reports only).
7. Optional criteria SHALL only be built after this check passes.

## Decisions

1. **One echo per commit.**
2. **Choosing the echo:** with an LLM configured, the LLM picks a quote or writes an
   explanation, and the engine verifies it (6.4 to 6.6). Without an LLM, or when the LLM's
   quote fails verification or the call fails, the deterministic rule order applies (6.3).
3. **Blame at HEAD.** Line numbers refer to HEAD; uncommitted edits are out of scope here.
4. **Failures degrade, never throw.** GitHub, LLM and cache failures add warnings. Only bad
   input (Requirement 3) throws `HadesConfigError`. This differs from summoning, which stops
   on LLM 401/403/404, because a missing echo is harmless while a wrong summoning run is not.
5. **GitHub HTTP client:** built on Node's `fetch` in the engine, so the engine still has no
   GitHub library dependency (summoning-engine Requirement 1.7). Octokit is used only in
   `packages/github`, later.
6. **Author:** name only, no email.
7. **Rename handling in `rankHaunted`:** none; paths are counted as written, and only paths
   that exist at HEAD are ranked.
8. **GitHub budget order:** blame and symbol-log commits first, then file-log commits, newest
   first in each group (5.7).
