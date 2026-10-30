import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // E2E builds into its own directory so it never clobbers a developer's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  // Monorepo root, so file tracing includes the API's dependencies in the Vercel function.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@relay/core', '@relay/ui', '@relay/api', '@relay/db', '@relay/routing'],
  // The embedded API's server libraries load from node_modules at runtime instead of being
  // bundled (native addons, Lua scripts and static files resolve relative to their package).
  serverExternalPackages: [
    '@fastify/cookie',
    '@fastify/cors',
    '@fastify/helmet',
    '@fastify/rate-limit',
    '@fastify/swagger',
    '@fastify/swagger-ui',
    '@node-rs/argon2',
    'bullmq',
    'drizzle-orm',
    'fastify',
    'fastify-type-provider-zod',
    'ioredis',
    'nodemailer',
    'postgres',
  ],
  // API paths (/api/v1, /voice, /healthz, /readyz, /api/cron) are route handlers in
  // src/app that run the API in-process or proxy to API_URL; see src/server/api-bridge.ts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
