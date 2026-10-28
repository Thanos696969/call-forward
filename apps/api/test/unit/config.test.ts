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
