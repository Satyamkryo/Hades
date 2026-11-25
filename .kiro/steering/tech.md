# Tech rules

- TypeScript everywhere, strict mode, Node.js 20+. ES modules.
- Monorepo with npm workspaces: packages/engine, packages/mcp-server,
  packages/vscode-ext, packages/github, packages/dashboard.
- MCP: official MCP TypeScript SDK, stdio transport.
- Git: real git commands via child processes (simple-git allowed).
- GitHub: Octokit. Tokens only from environment variables, never in code or logs.
- Cache: better-sqlite3, one file per repo under ~/.hades/.
- Tests: Vitest. Property-based tests with fast-check for core guarantees.
- LLM output must be structured JSON, validated with zod. Drop invalid comments.

## Safety rules (never break these)
- NEVER modify the user's real working tree. All summoning happens in a
  temporary `git worktree`, deleted afterwards.
- NEVER revert test files when undoing a fix.
- NEVER cite a commit SHA that doesn't exist in the repo.
- NEVER post GitHub comments unless the user explicitly runs a PR review.
- Every test run has a timeout (default 120s).
