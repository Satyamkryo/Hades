import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    // worktree.test.ts watches the shared temp dir for leftover hades-summon-* folders,
    // so files that create worktrees must not run at the same time.
    fileParallelism: false,
  },
});
