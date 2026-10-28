import { createHmac, randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { E2E } from '../playwright.config';

/** Sends webhooks exactly as the mock carrier would (HMAC-signed, timestamped). */
export async function carrierPost(
  request: APIRequestContext,
  path: string,
  params: Record<string, string>,
) {
  const body = new URLSearchParams(params).toString();
  const ts = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', E2E.mockSecret)
    .update(`${ts}.${E2E.apiUrl}${path}.${body}`)
    .digest('hex');
  return request.post(`${E2E.apiUrl}${path}`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-relay-mock-timestamp': String(ts),
      'x-relay-mock-signature': signature,
    },
    data: body,
  });
}

export const newCallSid = () => `CA${randomBytes(16).toString('hex')}`;
