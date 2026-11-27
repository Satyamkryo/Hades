# Real-repo check: dayjs (tasks 12.2, 12.3)

## Target (all runs)

- Repo: `E:\demo\dayjs` (clone of `https://github.com/iamkun/dayjs.git`)
- File: `src/index.js`, `--lines 1,60`, `--symbol parseDate`
- dayjs HEAD: `d3e43be0489ff1d010aca42b3115b6059215ed60` ("chore: update doc")
- Status before and after every run: clean; HEAD unchanged (the script checks both).
- Command (all runs): `npm run history-check -- E:\demo\dayjs src/index.js --lines 1,60 --symbol parseDate`
  (run 2 completed in 2.2 s total, implying `--no-github`; only the env differed).

## Run 1 — normal (local + llm + github without token, github rate-limited)

Real LLM key in env, no `GITHUB_TOKEN`.

- local question: 74 commits, 74 echoes (said 72 / inferred 0 / none 2), 9 git calls,
  ~1190 ms. Deterministic rule-order echoes; byte-identical to the no-LLM baseline.
- llm question (sub-run 2 of local → llm → github): 74 echoes (said 71 / inferred 1 /
  none 2). `d0e6738` got a better verbatim quote than the rule fallback (the rule
  order quotes the whole commit message cut at 300 chars — `d0e6738`'s message is a
  long multi-line body, so the cut lands mid-list; the LLM picked a tighter
  ≤300-char excerpt instead; still a verbatim substring, engine-verified). The single
  inferred echo is `5f3f878` ("fix: isDayjs check logic (#2383)") — the model's
  choice, contains `probably` + `<sha7>: ` prefix, engine-verified.
- github question: 74 commits, rate-limited partway (same shape as the recorded
  baseline run: 9 git calls, ~18 s, PRs found for a subset of commits).
- Judgement: the LLM quotes are genuine improvements where the rule fallback is
  blunt (long bodies), and the inferred echo is properly marked. No invented content
  anywhere — every `said` quote re-verified verbatim, every `inferred` marked.

## Run 2 — bad key (fake Meta key)

- The LLM endpoint answered 401. The engine handled it cleanly: one warning naming
  the failure, no throw, no crash.
- The fake key value never appeared in any output, warning, or cache row (the
  summary prints only the `***`-redacted message).
- All echoes fell back to the rule order, byte-identical to the local run
  (72 / 0 / 2). Total runtime 2.2 s.

## Run 3 — github without token, after the rate-limit reset

- `github.requests`: 30 (full budget), `rateLimited`: false, token: `no`.
- Commits with a PR: 22. Echoes quoting `pr-body`: 0, `issue-body`: 0.
- Judgement: expected, not a bug. Without an LLM the rule order always quotes the
  non-trivial commit message first, so PR/issue bodies never get quoted — they still
  contribute PR numbers and issue links. LLM slots (default cap 5) only reach the 5
  newest commits, and the 30-request GitHub budget only reaches part of the history.
  PR-body quotes need a working LLM *and* a commit within both caps (see run 4).

## Run 4 — real key + `GITHUB_TOKEN`

- github sub-run: 74 echoes (said 72 / inferred 0 / none 2). `5f3f878` moved from
  `inferred` (command 1's llm sub-run) to `said`, quoting PR #2383's body
  (`source.kind: pr-body, ref: 2383`) — verbatim, engine-verified. This is the
  strongest echo shape: an external record corroborating the commit.
- Token value never printed (summary shows `token: yes` only).
- Note: the model is not fully deterministic — inferred was 1 in command 1's llm
  sub-run and 0 in command 4's github sub-run — so exact confidence splits are not
  reproducible run to run. The guarantees (verbatim quotes, marked guesses) held in
  every run.

## Top haunted files (`rankHaunted`, defaults)

| File | Score | Fixes | Reverts | Churn |
| --- | --- | --- | --- | --- |
| types/index.d.ts | 65.2 | 21 | 0 | 22 |
| src/plugin/duration/index.js | 65.1 | 21 | 0 | 21 |
| src/index.js | 62.2 | 20 | 0 | 22 |
| src/plugin/customParseFormat/index.js | 62.0 | 20 | 0 | 20 |
| src/plugin/timezone/index.js | 56.0 | 18 | 0 | 20 |
| src/plugin/utc/index.js | 40.4 | 13 | 0 | 14 |
| types/plugin/duration.d.ts | 31.0 | 10 | 0 | 10 |
| src/constant.js | 28.0 | 9 | 0 | 10 |
| src/plugin/localeData/index.js | 28.0 | 9 | 0 | 10 |
| types/plugin/timezone.d.ts | 24.8 | 8 | 0 | 8 |

`commitsScanned: 500` (default cap), 6 git calls, ~479 ms, no warnings. No test or
non-code file ranked; every file verified present at HEAD. Plausible: duration,
timezone and customParseFormat are dayjs's most-fixed areas.

## Sample echoes (run 1, same first three in every run)

1. `b575c81` said [commit-message] "fix: timezone plugin currect parse UTC tz
   (#2693)" — the subject line of a timezone-parsing fix. Looks right.
2. `d0e6738` said [commit-message] "fix: Fix zero offset issue when use tz with
   locale (#2532) * test: add test case for tz with locale * fix: set utc as fa..."
   (multi-line body, cut at 300 chars) — explains a tz/locale offset fix plus its
   tests. Looks right; the real-LLM run quoted it better (see run 1 notes).
3. `2254635` said [commit-message] "fix: update $x logic to avoid plugin error
   (#2429)" — explains a plugin-error guard. Looks right.
4. The two `none` echoes (`5a4c2b5`, `53e17f7`) quote nothing because both commits
   say only `chore:` — there is genuinely no explanation. `none` is correct.

## Automatic checks

Every check passed (`RESULT: PASS`):

- All commit, echo and blame SHAs exist (`git cat-file -e <sha>^{commit}`).
- Every `said` quote verified verbatim against its source: commit messages via
  `git log -1 --format=%B`, PR/issue bodies against the bodies recorded during the
  run (including the run-4 `pr-body:2383` quote).
- Every `inferred` echo contains `probably` and starts with its `<sha7>: ` prefix.
- Every haunted path passes the test/non-code matchers and is in `git ls-tree HEAD`.
- dayjs HEAD and status unchanged after all runs.

Full JSON of the baseline run:
`~/.hades/history/dayjs-d3e43be-2026-11-26T15-49-03-257Z.json` (written by the
script, outside the target repo).
