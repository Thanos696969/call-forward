/**
 * Load smoke test for the voice hot path.
 *
 *   pnpm load:smoke [--rate 100] [--duration 15] [--to +18005550100] [--keep]
 *
 * Fires signed /voice/inbound webhooks (unique CallSid each, like real traffic)
 * at a fixed rate against a running API with TELEPHONY_PROVIDER=mock and a warm
 * route cache. Fails if p95 >= 300 ms or any request is not a 200 <Dial>.
 * Test calls are deleted afterwards unless --keep is passed.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import autocannon from 'autocannon';
import { loadEnvFile, signMockWebhook } from '@relay/core/server';
import { createDb } from '@relay/db';

loadEnvFile();

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: '100' },
    duration: { type: 'string', default: '15' },
    connections: { type: 'string', default: '20' },
    to: { type: 'string', default: '+18005550100' },
    api: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const target = (values.api ?? `http://localhost:${process.env.API_PORT ?? '4000'}`).replace(
  /\/$/,
  '',
);
const publicUrl = (process.env.PUBLIC_API_URL ?? target).replace(/\/$/, '');
const secret = process.env.MOCK_WEBHOOK_SECRET ?? 'dev-mock-webhook-secret';
const PREFIX = 'CALOAD';
const path = '/voice/inbound';

function signedRequest() {
  const body = new URLSearchParams({
    CallSid: `${PREFIX}${randomBytes(12).toString('hex')}`,
    From: '+13125550187',
    To: values.to,
  }).toString();
  return {
    method: 'POST' as const,
    path,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...signMockWebhook(secret, `${publicUrl}${path}`, body),
    },
  };
}

async function run(opts: { rate: number; duration: number; record: boolean }) {
  const latencies: number[] = [];
  let bad = 0;
  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(
      {
        url: target,
        connections: Number(values.connections),
        overallRate: opts.rate,
        duration: opts.duration,
        requests: [{ setupRequest: () => signedRequest() }],
      },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
    instance.on('response', (_client, statusCode, _bytes, responseTime) => {
      if (opts.record) latencies.push(responseTime);
      if (statusCode !== 200) bad++;
    });
  });
  return { result, latencies, bad };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? Number.NaN;
}

// Sanity check: the number must dial, otherwise we would be measuring the wrong path.
const probe = signedRequest();
const probeRes = await fetch(`${target}${path}`, {
  method: 'POST',
  headers: probe.headers,
  body: probe.body,
});
const probeBody = await probeRes.text();
if (probeRes.status !== 200 || !probeBody.includes('<Dial')) {
  console.error(
    `Probe failed (${probeRes.status}). Is the API running with TELEPHONY_PROVIDER=mock and ${values.to} forwarding?`,
  );
  console.error(probeBody.slice(0, 300));
  process.exit(1);
}

console.log('Warming up (3 s)…');
await run({ rate: 50, duration: 3, record: false });

const rate = Number(values.rate);
const duration = Number(values.duration);
console.log(`Measuring: ${rate} req/s for ${duration} s against ${target}${path}`);
const { result, latencies, bad } = await run({ rate, duration, record: true });
latencies.sort((a, b) => a - b);
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const p99 = percentile(latencies, 99);

console.log('');
console.log(
  `requests: ${latencies.length}  non-200: ${bad}  errors: ${result.errors}  timeouts: ${result.timeouts}`,
);
console.log(`throughput: ${result.requests.average.toFixed(1)} req/s`);
console.log(
  `latency ms  p50 ${p50.toFixed(1)}  p95 ${p95.toFixed(1)}  p99 ${p99.toFixed(1)}  max ${latencies.at(-1)?.toFixed(1)}`,
);

if (!values.keep) {
  const { sql, close } = createDb(process.env.DATABASE_URL, { max: 1 });
  const deleted = await sql`delete from calls where provider_call_id like ${`${PREFIX}%`}`;
  await close();
  console.log(`cleaned up ${deleted.count} load-test calls`);
}

const pass = bad === 0 && result.errors === 0 && p95 < 300;
console.log(pass ? '\nPASS: p95 < 300 ms' : '\nFAIL');
process.exit(pass ? 0 : 1);
