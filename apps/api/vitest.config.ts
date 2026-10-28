import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites share one Postgres + Redis pair started by Testcontainers.
    globalSetup: ['test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
