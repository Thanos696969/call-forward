import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
