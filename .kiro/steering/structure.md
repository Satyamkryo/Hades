# Structure

packages/engine        history reader, resurrector, reviewer, memory writer (pure logic, no UI)
packages/mcp-server    exposes engine functions as MCP tools; thin layer only
packages/vscode-ext    renders omens in Kiro IDE (Comments + Diagnostics APIs)
packages/github        Cerberus: PR review entry point (GitHub Action)
packages/dashboard     public demo page (The Graveyard, The Underworld report)
demo/                  scripts that clone demo repos at runtime (never commit their code)

Keep the engine independent of MCP, VS Code and GitHub so it can be tested alone.
Small files, one responsibility each. Explain non-obvious git commands in comments.
