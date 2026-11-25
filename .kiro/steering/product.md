# Product: Hades

Hades is an underworld-themed code reviewer for Kiro CLI and Kiro IDE, connected through MCP.
It reviews code and leaves comments ("omens"). It NEVER modifies the user's code.

Review scopes: uncommitted, committed (not pushed), pushed commits, GitHub pull requests.

Every omen is backed by git history evidence ("echoes": commit, PR, issue) with a confidence level:
- "said": quoted from a real commit message, PR or issue
- "inferred": guessed from the diff, must say "probably"
- "none": no record explains this; never invent a reason

Summoning: Hades undoes past bug fixes in a temporary git worktree and runs the
repo's tests, to prove which old bugs the current tests would miss.
Results: "escaped soul" (tests miss it), "buried" (tests catch it), "lost" (broken run).

Theme: one underworld theme everywhere (names, colors, icons). Explanations stay in
plain English. Severity stays plain: critical, warning, nitpick.
