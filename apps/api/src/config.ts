import { z } from 'zod';
import { resolveProviderId } from '@relay/core/server';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().default('postgres://relay:relay@localhost:5432/relay'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  WEB_URL: z.url().default('http://localhost:3000'),
  TRUST_PROXY: z.string().default('127.0.0.1,::1'),
  RATE_LIMIT_ENABLED: z.string().optional(),
  SESSION_COOKIE_SECURE: z.string().optional(),
  TELEPHONY_PROVIDER: z.string().optional(),
  MOCK_WEBHOOK_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_BASE: z.string().optional(),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Relay <no-reply@relay.local>'),
});

export const DEV_MOCK_SECRET = 'dev-mock-webhook-secret';

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  logLevel: string;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  publicApiUrl: string;
  webOrigin: string;
  webUrl: string;
  trustProxy: string[];
  rateLimitEnabled: boolean;
  sessionCookieSecure: boolean;
  smtp: { host: string; port: number; user?: string; password?: string; from: string };
  telephony: {
    TELEPHONY_PROVIDER?: string;
    MOCK_WEBHOOK_SECRET?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_API_BASE?: string;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(source);
  const isProd = e.NODE_ENV === 'production';
  const rateLimitEnabled = bool(true).parse(e.RATE_LIMIT_ENABLED);
  const sessionCookieSecure = bool(isProd).parse(e.SESSION_COOKIE_SECURE);
  const mockSecret = e.MOCK_WEBHOOK_SECRET || (isProd ? '' : DEV_MOCK_SECRET);

  const telephony = {
    TELEPHONY_PROVIDER: e.TELEPHONY_PROVIDER,
    MOCK_WEBHOOK_SECRET: mockSecret,
    TWILIO_ACCOUNT_SID: e.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: e.TWILIO_AUTH_TOKEN,
    TWILIO_API_BASE: e.TWILIO_API_BASE,
  };
  const providerId = resolveProviderId(telephony);
  if (isProd) {
    if (providerId === 'mock')
      throw new Error('TELEPHONY_PROVIDER=mock is not allowed in production');
    if (!sessionCookieSecure) throw new Error('SESSION_COOKIE_SECURE must be true in production');
  }

  return {
    env: e.NODE_ENV,
    isProd,
    logLevel: e.LOG_LEVEL,
    host: e.API_HOST,
    port: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    webOrigin: e.WEB_ORIGIN.replace(/\/$/, ''),
    webUrl: e.WEB_URL.replace(/\/$/, ''),
    trustProxy: e.TRUST_PROXY.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rateLimitEnabled,
    sessionCookieSecure,
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER || undefined,
      password: e.SMTP_PASSWORD || undefined,
      from: e.MAIL_FROM,
    },
    telephony,
  };
}

export function voiceUrls(config: Pick<Config, 'publicApiUrl'>) {
  return {
    voiceUrl: `${config.publicApiUrl}/voice/inbound`,
    resultUrl: `${config.publicApiUrl}/voice/result`,
    statusUrl: `${config.publicApiUrl}/voice/status`,
  };
}
