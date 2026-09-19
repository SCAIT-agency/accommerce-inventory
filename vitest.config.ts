import { defineConfig } from 'vitest/config'
import { configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Test files share one real dev database and truncate the same tables in
    // beforeEach — running files concurrently races those truncations.
    fileParallelism: false,
    // A git worktree checked out under .worktrees/ (e.g. for a parallel
    // session's own feature branch) carries its own full copy of every
    // *.test.ts file. Vitest's default glob is recursive, so without this
    // exclude a worktree's test files silently run alongside this checkout's
    // own — doubling the reported count and, worse, racing two independent
    // beforeEach truncation sequences against the same shared dev database.
    exclude: [...configDefaults.exclude, '.worktrees/**'],
  },
})
