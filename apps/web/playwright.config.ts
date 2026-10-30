import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs the real API (mock carrier) and the Next.js app on dedicated ports
 * against the local Postgres/Redis from docker-compose (or CI services).
 *
 * E2E_EMBEDDED=1 runs the Vercel layout instead: one production Next.js server with the API
 * embedded (no API process, no worker), so carrier webhooks go to the web origin.
 */
const API_PORT = 4010;
const WEB_PORT = 3010;
const embedded = process.env.E2E_EMBEDDED === '1';
const webUrl = `http://localhost:${WEB_PORT}`;
export const E2E = {
  apiUrl: embedded ? webUrl : `http://localhost:${API_PORT}`,
  webUrl,
  mockSecret: 'e2e-mock-webhook-secret-0123456789',
};

const useBuild = embedded || process.env.E2E_USE_BUILD === '1';

const apiEnv = {
  LOG_LEVEL: 'warn',
  PUBLIC_API_URL: E2E.apiUrl,
  WEB_ORIGIN: E2E.webUrl,
  WEB_URL: E2E.webUrl,
  TELEPHONY_PROVIDER: 'mock',
  MOCK_WEBHOOK_SECRET: E2E.mockSecret,
  RATE_LIMIT_ENABLED: 'false',
};

const embeddedServer = {
  command: `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`,
  url: `${E2E.webUrl}/readyz`,
  reuseExistingServer: false,
  timeout: 300_000,
  env: {
    ...apiEnv,
    NEXT_DIST_DIR: '.next-e2e-embedded',
    EMBED_API: 'true',
    JOBS_MODE: 'inline',
    ALLOW_MOCK_PROVIDER: 'true',
  },
};

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
  webServer: embedded
    ? [embeddedServer]
    : [
        {
          command: 'pnpm --filter @relay/api exec tsx src/server.ts',
          url: `${E2E.apiUrl}/readyz`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { ...apiEnv, NODE_ENV: 'test', API_PORT: String(API_PORT) },
        },
        {
          // The web app proxies API paths to API_URL; production mode builds into a separate
          // dist dir so it never clobbers a developer's .next.
          command: useBuild
            ? `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`
            : `pnpm exec next dev --port ${WEB_PORT}`,
          url: E2E.webUrl,
          reuseExistingServer: false,
          timeout: useBuild ? 300_000 : 120_000,
          env: { API_URL: E2E.apiUrl, NEXT_DIST_DIR: '.next-e2e' },
        },
      ],
});
