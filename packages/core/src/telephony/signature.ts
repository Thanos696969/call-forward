import { createHmac } from 'node:crypto';
import { safeEqual } from '../security/tokens';

/**
 * Twilio request signature:
 * base64(HMAC-SHA1(authToken, url + concat(sorted(key + value) for each POST param))).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function computeTwilioSignature(authToken: string, url: string, rawBody: string): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of new URLSearchParams(rawBody)) pairs.push([k, v]);
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? cmp(av, bv) : cmp(ak, bk)));
  const data = url + pairs.map(([k, v]) => k + v).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  rawBody: string,
  signature: string | undefined,
): boolean {
  if (!signature || !authToken) return false;
  return safeEqual(computeTwilioSignature(authToken, url, rawBody), signature);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Mock provider signing: hex HMAC-SHA256(secret, `${timestamp}.${url}.${rawBody}`). */
export const MOCK_SIGNATURE_HEADER = 'x-relay-mock-signature';
export const MOCK_TIMESTAMP_HEADER = 'x-relay-mock-timestamp';
/** Signed mock webhooks older (or newer) than this are rejected as replays. */
export const MOCK_REPLAY_WINDOW_SEC = 300;

export function signMockWebhook(
  secret: string,
  url: string,
  rawBody: string,
  timestampSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSec}.${url}.${rawBody}`, 'utf8')
    .digest('hex');
  return {
    [MOCK_TIMESTAMP_HEADER]: String(timestampSec),
    [MOCK_SIGNATURE_HEADER]: signature,
  };
}

export function verifyMockSignature(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
  url: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const ts = headers[MOCK_TIMESTAMP_HEADER];
  const sig = headers[MOCK_SIGNATURE_HEADER];
  if (!secret || !ts || !sig || !/^\d{1,12}$/.test(ts)) return false;
  const tsNum = Number(ts);
  if (Math.abs(nowSec - tsNum) > MOCK_REPLAY_WINDOW_SEC) return false;
  const expected = signMockWebhook(secret, url, rawBody, tsNum)[MOCK_SIGNATURE_HEADER] ?? '';
  return safeEqual(expected, sig);
}
