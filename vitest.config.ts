import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Test files share one real dev database and truncate the same tables in
    // beforeEach — running files concurrently races those truncations.
    fileParallelism: false,
  },
})
