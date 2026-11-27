# @hades/engine

The Hades engine. It holds the logic only: no UI, no MCP, no GitHub. Other packages call it.

## Trust warning

**Only run summoning on repos you trust.** Summoning runs the repo's own test command
(`npm test` by default), and that command runs the repo's own scripts. If you set
`installCommand`, the engine also runs the repo's install scripts. Both execute arbitrary
code from the repo on your machine, with your user's permissions. The engine does not
sandbox them.

## What summoning does

Summoning checks whether a repo's tests would catch its own old bugs.

1. Scans recent history for commits that look like bug fixes (messages with fix/bug/crash/
   hotfix, closing issue links, reverts). Small histories, or histories with few matching
   messages, are reviewed by diff instead of by message.
2. Asks an LLM to confirm each candidate really is a bug fix.
3. For each confirmed fix, creates a temporary `git worktree` at the current `HEAD`,
   undoes the fix there, and runs the test command with a timeout.
4. Labels the result, deletes the worktree, and returns a report.

Only non-test source files of the fix are undone. Test files are never reverted. Your real
working tree is never touched. Hades never modifies your code.

Before any fix is summoned, the tests run once on the unmodified `HEAD` (the baseline). If
the baseline fails, nothing is summoned and the report status is `baseline-failed`.

## Labels

| Label | Meaning |
| --- | --- |
| `escaped` | The bug came back and the tests still passed. The tests would miss it. |
| `buried` | The bug came back and the tests failed. The tests catch it. |
| `lost` | The run could not give a verdict. The entry carries a `lostReason`. |

Lost reasons:

- `revert did not apply`: the fix could not be undone cleanly (for example later commits
  changed the same lines).
- `timeout`: the test run exceeded `timeoutMs`.
- `dependency setup failed`: linking or installing dependencies in the worktree failed.
- `no source files to revert`: the fix only changed test or non-code files.
- `fix changes dependencies`: the fix changed a lockfile or the dependency fields of
  `package.json`, so the old dependencies cannot be linked in. Set `installCommand` to
  summon these.
- `flaky tests`: reserved for reruns, which are not built yet (see `rerunOnFail`).
- `test command failed to start`: the test command could not be launched.
- `parent commit not available`: the fix commit has no parent in this clone.
- `internal error: <detail>`: an unexpected failure while processing that fix.

## Report

`resurrect()` returns an `UnderworldReport`. Its `status` is one of:

- `ok`: the baseline passed and fixes were processed. See `entries`.
- `baseline-failed`: the tests fail on the untouched `HEAD`. See `baseline.reason` and
  `baseline.excerpt`. No fix is summoned, and no LLM call is made.
- `no-tests`: the repo has no test suite (no `scripts.test` in `package.json`, or it is the
  `no test specified` placeholder) and you did not pass `testCommand`. No worktree is
  created. Confirmed fixes are listed in `unguarded` (SHA, message, rules, reason, all
  changed files), and `entries` is empty. These are past fixes with nothing guarding them.

The report also holds `rejected` (the LLM said "not a bug fix"), `llmErrors`, `warnings`,
`totals`, the redacted resolved `options`, and `droppedUnverified`. Every SHA in a report
is checked against the repo before it is returned.

## Use from code

```ts
import { resurrect } from "@hades/engine";

const report = await resurrect("/absolute/path/to/repo", {
  limit: 10,
  testCommand: "npm test",
  timeoutMs: 120_000,
});

for (const entry of report.entries) {
  console.log(entry.label, entry.sha, entry.lostReason ?? "");
}
```

Signature: `resurrect(repoPath, options?, deps?)`.

- `repoPath` must be an absolute path to the top level of a git repo (git 2.30 or newer).
- `options` is described below. Invalid options throw `HadesConfigError` before any git
  command runs.
- `deps.llm` lets you pass your own LLM client (used by tests). If omitted, the engine
  builds a client from the environment variables below.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `testCommand` | `"npm test"` | Command run in each worktree. |
| `timeoutMs` | `120000` | Time limit for each test run. |
| `limit` | none | Stop after this many confirmed fixes. |
| `maxCommits` | `500` | Most recent commits to scan. |
| `maxLlmChecks` | `50` | Most LLM confirmation calls (errors count). |
| `extraTestPatterns` | `[]` | Extra glob patterns for files treated as tests (never reverted). |
| `extraNonCodePatterns` | `[]` | Extra glob patterns for files treated as non-code (never reverted). |
| `installCommand` | none | Command that installs dependencies in a worktree. Runs install scripts. |
| `installTimeoutMs` | `600000` | Time limit for `installCommand`. |
| `alwaysInstall` | `false` | Run `installCommand` even when `node_modules` could be linked. Requires `installCommand`. |
| `excerptChars` | `4000` | Most characters of test output kept per entry. |
| `rerunOnFail` | `0` | Accepted (0 to 3) but reruns are not built yet, so it has no effect. |

Without `installCommand`, the engine links the repo's existing `node_modules` into each
worktree. Run `npm install` in the repo first.

## LLM environment variables

The engine talks to an OpenAI-compatible `/chat/completions` endpoint. All three are
required, and a missing one is named in the error.

| Variable | Meaning |
| --- | --- |
| `HADES_LLM_BASE_URL` | Base URL of the API, without `/chat/completions`. |
| `HADES_LLM_API_KEY` | API key. Never logged, never in reports, hidden from test commands. |
| `HADES_LLM_MODEL` | Model name. |

## History reader

`askHistory()` answers "what does history say about this file?": the commits
that touched a file, line range or symbol, one echo (history evidence) per
commit, and warnings.

```ts
import { askHistory } from "@hades/engine";

const answer = await askHistory("/absolute/path/to/repo", "src/pay.ts", {
  lines: [10, 20],
  symbol: "charge",
});
```

Signature: `askHistory(repo, file, options?, deps?)`.

- `repo` must be an absolute path to the top level of a git repo. `file` is a
  repo-relative path (deleted files have history too). Invalid input throws
  `HadesConfigError` before any git call.
- Everything is read-only: git and GitHub are only read, and nothing is
  written to the repo, `.kiro/` or GitHub. The only file written is the cache
  at `~/.hades/<repo-id>.db` (override with `deps.hadesHome`, never inside
  the repo).
- GitHub context (linked PRs and issues) is optional: it runs only when the
  repo's `origin` is on `github.com`, uses GET requests only, and stays
  within `maxGithubRequests` per question (0 turns it off). Pass your own
  client as `deps.github`, or `null` to turn it off. Without a token the
  client works unauthenticated.
- Echoes come from the commit message, PR and issue bodies, or from an LLM
  when one is configured (`deps.llm`, or the `HADES_LLM_*` variables from
  the LLM section above). `deps.llm: null` turns the LLM off; fewer than
  `maxLlmChecks` commits get an LLM slot, the rest use the rule order.
- Secrets come only from the environment: `GITHUB_TOKEN` for GitHub, the
  `HADES_LLM_*` variables for the LLM. Both are stripped from git child
  processes and redacted from every warning.
- `deps` also takes `llmModel`, `now` (clock, used by tests) and `env`
  (environment, used by tests), as `resurrect()` does.

Options: `lines` (a `[start, end]` tuple), `symbol` (function name),
`maxCommits` (50), `excerptChars` (4000), `maxGithubRequests` (30),
`githubTimeoutMs` (10000), `githubTtlMs` (86400000), `maxLlmChecks` (5).

## Run from the command line

From the repo root:

```
npm run summon -- <absolute repo path> [--limit N] [--test-command "<cmd>"] [--timeout <seconds>]
```

- `--limit N`: positive integer, maps to `limit`.
- `--test-command "<cmd>"`: non-empty, maps to `testCommand`.
- `--timeout <seconds>`: positive whole number of seconds, maps to `timeoutMs`.

The script prints a summary, then writes the full JSON report to
`~/.hades/reports/<repo name>-<short sha>-<timestamp>.json` and prints that path. It
refuses to write a report inside the target repo.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Finished: status `ok` or `no-tests`. |
| `2` | Baseline failed. |
| `1` | Error (bad arguments, bad config, missing LLM variables, git failure). |
| `130` | Stopped with Ctrl+C. |

**Ctrl+C:** the script prints, but does not run, the commands to remove any worktrees this
run left behind (removing a `node_modules` link first, then `git worktree unlock`, then
`git worktree remove --force`). Run them yourself if you stop a run midway.
