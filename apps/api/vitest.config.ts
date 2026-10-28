import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites share one Postgres + Redis container pair per file.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
