/**
 * Simulate a carrier call against the mock provider.
 *
 *   pnpm --filter @relay/api simulate-call --to +18005550100 --from +15551230000 \
 *     [--outcome completed|no-answer|busy|failed|canceled] [--duration 42] [--ring 3]
 *
 * Sends signed /voice/inbound, then /voice/result and /voice/status like a real
 * carrier would. Requires TELEPHONY_PROVIDER=mock on the API.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { loadEnvFile, signMockWebhook } from '@relay/core/server';

loadEnvFile();

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    from: { type: 'string', default: '+15551230000' },
    outcome: { type: 'string', default: 'completed' },
    duration: { type: 'string', default: '42' },
    ring: { type: 'string', default: '2' },
    api: { type: 'string' },
    'public-url': { type: 'string' },
    secret: { type: 'string' },
  },
  allowPositionals: true,
});

const OUTCOMES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);
if (!values.to) {
  console.error(
    'Usage: simulate-call --to +18005550100 [--from +15551230000] [--outcome completed] [--duration 42]',
  );
  process.exit(2);
}
if (!OUTCOMES.has(values.outcome)) {
  console.error(`--outcome must be one of ${[...OUTCOMES].join(', ')}`);
  process.exit(2);
}

const port = process.env.API_PORT ?? '4000';
const target = (values.api ?? `http://localhost:${port}`).replace(/\/$/, '');
const publicUrl = (values['public-url'] ?? process.env.PUBLIC_API_URL ?? target).replace(/\/$/, '');
const secret = values.secret ?? process.env.MOCK_WEBHOOK_SECRET ?? 'dev-mock-webhook-secret';
const callSid = `CA${randomBytes(16).toString('hex')}`;

async function post(path: string, params: Record<string, string>) {
  const body = new URLSearchParams(params).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...signMockWebhook(secret, `${publicUrl}${path}`, body),
  };
  const started = performance.now();
  const res = await fetch(`${target}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  const ms = (performance.now() - started).toFixed(1);
  console.log(`\nPOST ${path} → ${res.status} (${ms} ms)`);
  if (text) console.log(text);
  if (!res.ok) process.exit(1);
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`Simulating call ${callSid}: ${values.from} → ${values.to} (${values.outcome})`);
const twiml = await post('/voice/inbound', {
  CallSid: callSid,
  From: values.from,
  To: values.to,
  CallStatus: 'ringing',
  Direction: 'inbound',
});
if (!twiml.includes('<Dial')) {
  console.log('\nThe router did not dial (number not in service or not configured). Done.');
  process.exit(0);
}

await sleep(Number(values.ring) * 1000);
const answered = values.outcome === 'completed';
await post('/voice/result', {
  CallSid: callSid,
  DialCallSid: `CA${randomBytes(16).toString('hex')}`,
  DialCallStatus: values.outcome,
  DialCallDuration: answered ? values.duration : '0',
});
await post('/voice/status', {
  CallSid: callSid,
  CallStatus: answered ? 'completed' : values.outcome === 'canceled' ? 'canceled' : 'completed',
  CallDuration: answered ? values.duration : '0',
});
console.log('\nDone. The call is in the call log.');
