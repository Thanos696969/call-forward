import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs the real API (mock carrier) and the Next.js app on dedicated ports
 * against the local Postgres/Redis from docker-compose (or CI services).
 */
const API_PORT = 4010;
const WEB_PORT = 3010;
export const E2E = {
  apiUrl: `http://localhost:${API_PORT}`,
  webUrl: `http://localhost:${WEB_PORT}`,
  mockSecret: 'e2e-mock-webhook-secret',
};

const useBuild = process.env.E2E_USE_BUILD === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: E2E.webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @relay/api exec tsx src/server.ts',
      url: `${E2E.apiUrl}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        API_PORT: String(API_PORT),
        PUBLIC_API_URL: E2E.apiUrl,
        WEB_ORIGIN: E2E.webUrl,
        WEB_URL: E2E.webUrl,
        TELEPHONY_PROVIDER: 'mock',
        MOCK_WEBHOOK_SECRET: E2E.mockSecret,
        RATE_LIMIT_ENABLED: 'false',
      },
    },
    {
      command: useBuild
        ? `pnpm exec next start --port ${WEB_PORT}`
        : `pnpm exec next dev --port ${WEB_PORT}`,
      url: E2E.webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_URL: E2E.apiUrl },
    },
  ],
});
