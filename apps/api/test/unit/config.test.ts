import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { localDays } from '../../src/routes/calls';
import { decodeCursor, encodeCursor } from '../../src/lib/cursor';

describe('config', () => {
  it('works with no env at all (clean clone)', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 4000, rateLimitEnabled: true, sessionCookieSecure: false });
    expect(c.telephony.MOCK_WEBHOOK_SECRET).toBeTruthy();
  });

  it('refuses unsafe production settings', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', TELEPHONY_PROVIDER: 'mock' })).toThrow(
      /mock/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        TELEPHONY_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 't',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow(/SESSION_COOKIE_SECURE/);
    const prod = loadConfig({
      NODE_ENV: 'production',
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 't',
    });
    expect(prod.sessionCookieSecure).toBe(true);
    expect(prod.telephony.MOCK_WEBHOOK_SECRET).toBe('');
  });
});

describe('dashboard day buckets', () => {
  it('labels days in the organisation timezone', () => {
    // 2026-03-08 is the US DST change; the range covers three New York days.
    const from = new Date('2026-03-07T05:00:00Z');
    const to = new Date('2026-03-10T04:00:00Z');
    expect(localDays(from, to, 'America/New_York')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect(
      localDays(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:01Z'), 'Asia/Kolkata'),
    ).toEqual(['2026-01-01']);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const c = encodeCursor('2026-01-01T00:00:00.000Z', 'abc');
    expect(decodeCursor(c)).toEqual({ sortKey: '2026-01-01T00:00:00.000Z', id: 'abc' });
    expect(() => decodeCursor('not-base64-json')).toThrow();
  });
});

describe('serverless config', () => {
  const twilio = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' };

  it('derives every URL and inline jobs from Vercel defaults', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'relay-demo.vercel.app',
      KV_URL: 'rediss://default:pw@us1.upstash.io:6379',
      ...twilio,
    });
    expect(c).toMatchObject({
      serverless: true,
      jobsMode: 'inline',
      dbPoolMax: 5,
      publicApiUrl: 'https://relay-demo.vercel.app',
      webUrl: 'https://relay-demo.vercel.app',
      webOrigin: 'https://relay-demo.vercel.app',
      redisUrl: 'rediss://default:pw@us1.upstash.io:6379',
    });
  });

  it('lets explicit URLs win over Vercel defaults', () => {
    const c = loadConfig({
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'relay-demo.vercel.app',
      PUBLIC_API_URL: 'https://calls.example.com/',
    });
    expect(c.publicApiUrl).toBe('https://calls.example.com');
    expect(c.webUrl).toBe('https://relay-demo.vercel.app');
  });

  it('keeps the standalone defaults off Vercel', () => {
    expect(loadConfig({})).toMatchObject({ serverless: false, jobsMode: 'queue', dbPoolMax: 20 });
  });

  it('allows the mock carrier in production only as an explicit demo with a strong secret', () => {
    const demo = {
      NODE_ENV: 'production',
      TELEPHONY_PROVIDER: 'mock',
      ALLOW_MOCK_PROVIDER: 'true',
    };
    expect(() => loadConfig(demo)).toThrow(/MOCK_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...demo, MOCK_WEBHOOK_SECRET: 'short' })).toThrow(/24/);
    const ok = loadConfig({ ...demo, MOCK_WEBHOOK_SECRET: 'x'.repeat(32) });
    expect(ok.telephony.MOCK_WEBHOOK_SECRET).toBe('x'.repeat(32));
  });
});

describe('pooled Postgres URLs', () => {
  it('sends unprepared statements through transaction poolers only', async () => {
    const { isPooledUrl } = await import('@relay/db');
    expect(isPooledUrl('postgres://u:p@ep-cool-123-pooler.us-east-1.aws.neon.tech/db')).toBe(true);
    expect(isPooledUrl('postgres://u:p@db.example.com:6543/postgres')).toBe(true);
    expect(isPooledUrl('postgres://u:p@host/db?pgbouncer=true')).toBe(true);
    expect(isPooledUrl('postgres://u:p@ep-cool-123.us-east-1.aws.neon.tech/db')).toBe(false);
    expect(isPooledUrl('postgres://relay:relay@localhost:5432/relay')).toBe(false);
  });
});
