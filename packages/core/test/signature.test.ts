import { describe, expect, it } from 'vitest';
import {
  MOCK_REPLAY_WINDOW_SEC,
  computeTwilioSignature,
  signMockWebhook,
  verifyMockSignature,
  verifyTwilioSignature,
} from '../src/telephony/signature';
import { generateToken, hashToken, safeEqual } from '../src/security/tokens';

// Reference vector from Twilio's own SDK test suite.
const TOKEN = '12345';
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const BODY = new URLSearchParams({
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675309',
  Digits: '1234',
  From: '+14158675309',
  To: '+18005551212',
}).toString();
const EXPECTED = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

describe('Twilio signature', () => {
  it('matches the reference vector', () => {
    expect(computeTwilioSignature(TOKEN, URL_, BODY)).toBe(EXPECTED);
  });

  it('is independent of form field order', () => {
    const shuffled = BODY.split('&').reverse().join('&');
    expect(computeTwilioSignature(TOKEN, URL_, shuffled)).toBe(EXPECTED);
  });

  it('accepts a valid signature', () => {
    expect(verifyTwilioSignature(TOKEN, URL_, BODY, EXPECTED)).toBe(true);
  });

  it('rejects a tampered body, wrong URL, wrong token or missing header', () => {
    expect(verifyTwilioSignature(TOKEN, URL_, BODY.replace('1234', '9999'), EXPECTED)).toBe(false);
    expect(
      verifyTwilioSignature(TOKEN, 'https://evil.example/myapp.php?foo=1&bar=2', BODY, EXPECTED),
    ).toBe(false);
    expect(verifyTwilioSignature('other-token', URL_, BODY, EXPECTED)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, BODY, undefined)).toBe(false);
    expect(verifyTwilioSignature('', URL_, BODY, EXPECTED)).toBe(false);
  });
});

describe('mock provider signature', () => {
  const secret = 'test-secret';
  const url = 'http://localhost:4000/voice/inbound';
  const body = 'CallSid=CA1&From=%2B15551230000&To=%2B18005550100';
  const now = 1_800_000_000;

  it('accepts a fresh, correctly signed request', () => {
    expect(
      verifyMockSignature(secret, signMockWebhook(secret, url, body, now), body, url, now),
    ).toBe(true);
  });

  it('rejects an invalid signature', () => {
    const headers = signMockWebhook('wrong-secret', url, body, now);
    expect(verifyMockSignature(secret, headers, body, url, now)).toBe(false);
    expect(
      verifyMockSignature(secret, signMockWebhook(secret, url, body, now), `${body}&x=1`, url, now),
    ).toBe(false);
    expect(verifyMockSignature(secret, {}, body, url, now)).toBe(false);
  });

  it('rejects replays outside the window', () => {
    const old = signMockWebhook(secret, url, body, now - MOCK_REPLAY_WINDOW_SEC - 1);
    expect(verifyMockSignature(secret, old, body, url, now)).toBe(false);
    const future = signMockWebhook(secret, url, body, now + MOCK_REPLAY_WINDOW_SEC + 1);
    expect(verifyMockSignature(secret, future, body, url, now)).toBe(false);
    const edge = signMockWebhook(secret, url, body, now - MOCK_REPLAY_WINDOW_SEC);
    expect(verifyMockSignature(secret, edge, body, url, now)).toBe(true);
  });
});

describe('session token hashing', () => {
  it('stores SHA-256 hex, never the raw token', () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
    expect(hashToken(`${token}x`)).not.toBe(hash);
  });

  it('generates 32 random bytes by default', () => {
    const token = generateToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateToken()).not.toBe(token);
  });

  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
