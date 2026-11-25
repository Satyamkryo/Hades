# AGENTS.md — Hades

Everything an AI agent needs to work on this repo. Read this first.

## What Hades is

Hades is an underworld-themed code reviewer for Kiro CLI and Kiro IDE, connected through MCP.
It reviews code and leaves comments. **It never modifies the user's code.**

Every comment is backed by evidence from the repo's git history, and Hades can prove which
old bugs the current tests would miss by bringing those bugs back in a safe copy of the repo.

## Features

### 1. Review scopes

| Scope | What gets reviewed | Git | Output |
| --- | --- | --- | --- |
| Uncommitted | Staged, unstaged and new files | `git diff HEAD` + untracked | IDE, CLI |
| Committed | Local commits not pushed | `git log @{u}..HEAD` (fall back to `main` if no upstream) | IDE, CLI |
| Pushed | Commits on GitHub; default last 5 | `git log origin/<branch>` | IDE, CLI |
| Pull request | A PR by number or link | GitHub API diff | GitHub PR + IDE |

Pushed and PR reviews look at the most-fixed, most-reverted files first to save LLM calls.

### 2. Every comment (an "omen") contains

- Walkthrough summary at the top of a review
- Line comment with severity: critical, warning, nitpick
- Suggested change shown as a diff — **never applied**
- "Prompt for AI agent" block the user can copy
- Thread replies for follow-up questions
- **Echo**: history evidence (commit, PR, issue) with confidence:
  - `said` — quoted from a real commit message, PR or issue
  - `inferred` — guessed from the diff; must say "probably"
  - `none` — no record explains it; never invent a reason
- **Escaped soul** badge when an old bug in this code would not be caught by the tests

### 3. Summoning (bug resurrection)

1. Find bug-fix commits: fix/bug/crash/hotfix/revert in messages, `#123` issue links, reverts.
2. Confirm each with an LLM call returning JSON `{isBugFix, reason}`.
3. In a temporary `git worktree`, reverse-apply only the NON-test files of the fix.
4. Run the repo's test command with a timeout (default 120s).
5. Label: `escaped` (tests pass), `buried` (tests fail), `lost` (revert or build failed).
6. Delete the worktree. Report SHA, message, files, label, test output excerpt, totals.
7. Suggest a test that would catch each escaped bug — shown, never added.

### 4. Memory and warnings

- Write `.kiro/steering/hades-<area>.md` with `inclusion: fileMatch` so Kiro loads an area's
  bug history only when touching that area. Link evidence with `#[[file:...]]`.
- A `PreToolUse` hook warns before Kiro edits code with an escaped bug in its history.

## Theme: the underworld (use everywhere)

| Concept | Name |
| --- | --- |
| Review | Judgment |
| Review comment | Omen |
| History evidence | Echo |
| Past bug fixes | The Graveyard |
| Resurrection run | Summoning |
| Survived bug | Escaped soul |
| Killed bug | Buried |
| Broken run | Lost |
| Resurrection report | The Underworld |
| PR review bot | Cerberus |
| Steering memory | The Archive |

Colors: background `#0E0B10`, ember `#FF7A3D` (warnings, buttons), blood `#C8323C`
(critical, escaped souls), spirit `#5FD4C4` (echoes), bone `#E9E3D8` (text), ash `#7A7280`
(quiet text).

Rules: names, colors and icons carry the theme; explanations stay in plain English, never
roleplay. Severity stays plain. Everything original — nothing from the Hades video game.

Example omen:

```
Omen · critical — Escaped soul
Removing this retry brings back the payment timeout fixed in PR #57.
Hades summoned that bug and your tests still passed.
Echo: "added retry because payment API times out" (PR #57, said)
```

## Architecture

Kiro CLI / Kiro IDE is the brain. Hades is an MCP server (the toolbox). We do not build our
own agent loop.

```
Kiro CLI · Kiro IDE + extension · Cerberus (GitHub Action / Kiro Crew bot)
                         │ MCP
              Hades engine (MCP server)
  history reader · resurrector · reviewer · comment renderer · memory writer
                         │
     git repo (temp worktrees only) · GitHub API · LLM · .kiro folder
```

MCP tools: `summon(repo)`, `ask_history(file, symbol?)`, `resurrect(repo, limit?)`,
`resurrection_report(repo)`, `review(scope, target?)`, `review_pr(number)`, `remember(repo)`.

## Stack

- TypeScript everywhere, strict, Node.js 20+, ES modules, npm workspaces
- MCP: official MCP TypeScript SDK, stdio
- Git: real git via child processes (`simple-git` allowed)
- GitHub: Octokit, token from env only
- Cache: `better-sqlite3`, one file per repo under `~/.hades/`
- LLM output: structured JSON validated with `zod`; drop invalid comments
- Tests: Vitest + `fast-check` property tests
- IDE: VS Code extension API (Comments + Diagnostics), runs in Kiro IDE
- Demo repos: JS/TS with Vitest or Jest

## Repo layout

```
.kiro/            specs, steering, hooks, settings/mcp.json  (never gitignore)
packages/engine        pure logic, no UI, testable alone
packages/mcp-server    thin MCP layer over the engine
packages/vscode-ext    omens in Kiro IDE
packages/github        Cerberus PR reviewer
packages/dashboard     public demo page (The Graveyard, The Underworld)
demo/                  scripts that clone demo repos at runtime
```

## Safety rules (never break)

- NEVER modify the user's real working tree. Summoning happens only in temp worktrees.
- NEVER revert test files.
- NEVER cite a commit SHA that doesn't exist.
- NEVER post GitHub comments unless the user explicitly runs a PR review, and only on repos
  the user owns or their forks.
- Every test run has a timeout.
- Secrets (GitHub token, LLM keys) only in environment variables. Never commit them.
- Demo repos are cloned at runtime into a folder outside this repo; never commit them.

## Required property tests

- The user's working tree is unchanged after any summoning run.
- Reverse-apply then re-apply restores the exact original files.
- Test files are never in a reverted file set.
- Every cited SHA exists in the repo.
- A `said` echo always quotes text that exists in a commit, PR or issue.

## How we work

- Kiro builds the code. One Kiro spec per feature (requirements → design → tasks), in
  `.kiro/specs/<feature>/`. Get approval before moving to the next file.
- Build order (riskiest first): summoning engine → history reader + MCP server → reviewer →
  IDE extension → PR review → memory + hooks → dashboard → (optional) Kiro Crew bot.
- Each phase ends with a checkpoint that must pass before the next.
- Ask before writing code when the approach is unclear.
- Git: commits are authored by the repo owner only. Never add AI co-authors,
  "generated by" lines or session links to commits, PRs or files.
