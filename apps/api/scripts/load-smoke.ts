/**
 * Routing engine load test.
 *
 *   pnpm load:smoke [--rate 100] [--duration 30] [--api http://localhost:4000] [--keep]
 *   pnpm load:smoke --api http://localhost:3100,http://localhost:3101   (round-robin instances)
 *
 * Open-loop: starts `rate` new calls per second regardless of how fast earlier
 * ones finish (the way carriers deliver traffic). Each call walks the real
 * voice path: signed /voice/inbound → hold 0–3 s → /voice/result with a random
 * outcome → on no-answer/busy the router fails over → another result → ...
 * Calls are held so live legs pile up (~150 at 100 calls/s), which makes the
 * concurrency caps bind and forces failover across tiers.
 *
 * A dedicated organisation, number and 3-tier campaign are created in Postgres
 * and removed afterwards (unless --keep). While running, every target's live-leg
 * set is sampled to prove no concurrency cap is ever exceeded.
 * Requires TELEPHONY_PROVIDER=mock on the API. Fails if any request fails or
 * any webhook p95 >= 300 ms or a cap is exceeded.
 */
import { parseArgs } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadEnvFile, signMockWebhook } from '@relay/core/server';
import { createDb } from '@relay/db';
import { keys } from '@relay/routing';

loadEnvFile();

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: '100' },
    duration: { type: 'string', default: '30' },
    api: { type: 'string' },
    keep: { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});

// Several comma-separated instances are used round-robin per request, the way a serverless
// platform spreads webhooks; any instance must be able to handle any step of any call.
const apiUrls = (values.api ?? `http://localhost:${process.env.API_PORT ?? '4000'}`)
  .split(',')
  .map((u) => u.trim().replace(/\/$/, ''))
  .filter(Boolean);
const publicUrl = (process.env.PUBLIC_API_URL ?? apiUrls[0]!).replace(/\/$/, '');
let nextApi = 0;
const pickTarget = () => apiUrls[nextApi++ % apiUrls.length]!;
const secret = process.env.MOCK_WEBHOOK_SECRET ?? 'dev-mock-webhook-secret';
const rate = Number(values.rate);
const duration = Number(values.duration);

const { sql, close } = createDb(process.env.DATABASE_URL, { max: 2 });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

// ── Fixture: org, number, 3-tier campaign ───────────────────────────────────
const slug = `load-${randomUUID().slice(0, 8)}`;
const e164 = `+1888${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
const [org] = await sql<
  { id: string }[]
>`insert into organizations (name, slug) values ('Load test', ${slug}) returning id`;
const orgId = org!.id;
const [campaign] = await sql<{ id: string }[]>`
  insert into campaigns (org_id, name, routing_mode, ring_timeout_sec) values (${orgId}, 'Load', 'sequential', 20) returning id`;
const specs = [
  { name: 'A', tier: 1, weight: 70, cc: 20, hourly: null },
  { name: 'B', tier: 1, weight: 30, cc: 20, hourly: null },
  { name: 'C', tier: 2, weight: 50, cc: 40, hourly: null },
  { name: 'D', tier: 2, weight: 50, cc: 40, hourly: null },
  { name: 'E', tier: 3, weight: 100, cc: 100, hourly: 2000 },
];
const targets: Array<{ id: string; name: string; cc: number }> = [];
let n = 0;
for (const s of specs) {
  const [t] = await sql<{ id: string }[]>`
    insert into targets (org_id, campaign_id, name, destination, priority_tier, weight, cc_cap, hourly_cap, created_at)
    values (${orgId}, ${campaign!.id}, ${s.name}, ${`+1415555${String(1000 + n)}`}, ${s.tier}, ${s.weight}, ${s.cc}, ${s.hourly},
            now() + make_interval(secs => ${n++}))
    returning id`;
  targets.push({ id: t!.id, name: s.name, cc: s.cc });
}
await sql`insert into phone_numbers (org_id, e164, country, number_type, provider, status, campaign_id)
          values (${orgId}, ${e164}, 'US', 'toll_free', 'mock', 'active', ${campaign!.id})`;

// ── Traffic ─────────────────────────────────────────────────────────────────
type Endpoint = 'inbound' | 'result';
const latency: Record<Endpoint, number[]> = { inbound: [], result: [] };
let failures = 0;
const outcomes: Record<string, number> = {};
let attemptsTotal = 0;

async function post(path: string, params: Record<string, string>, kind: Endpoint): Promise<string> {
  const body = new URLSearchParams(params).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...signMockWebhook(secret, `${publicUrl}${path}`, body),
  };
  const t0 = performance.now();
  const res = await fetch(`${pickTarget()}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  latency[kind].push(performance.now() - t0);
  if (!res.ok) failures++;
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const actionOf = (twiml: string) =>
  /<Dial[^>]*action="([^"]+)"/.exec(twiml)?.[1]?.replace(/&amp;/g, '&');

async function oneCall() {
  const sid = `CALOAD${randomBytes(12).toString('hex')}`;
  let twiml = await post(
    '/voice/inbound',
    {
      CallSid: sid,
      From: `+1312${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      To: e164,
    },
    'inbound',
  );
  let outcome = 'exhausted';
  for (let attempt = 1; ; attempt++) {
    const action = actionOf(twiml);
    if (!action) break;
    attemptsTotal++;
    await sleep(Math.random() * 3000); // ring + talk time while the slot is held
    const r = Math.random();
    const status = r < 0.6 ? 'completed' : r < 0.8 ? 'no-answer' : r < 0.95 ? 'busy' : 'failed';
    twiml = await post(
      action.slice(publicUrl.length),
      {
        CallSid: sid,
        DialCallStatus: status,
        DialCallDuration: status === 'completed' ? '42' : '0',
      },
      'result',
    );
    outcome = status;
    if (status === 'completed') break;
  }
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
}

const maxLive = new Map<string, number>();
const sampler = setInterval(async () => {
  const counts = await Promise.all(
    targets.map((t) => redis.zcount(keys.live(t.id), `(${Date.now()}`, '+inf')),
  );
  targets.forEach((t, i) => maxLive.set(t.id, Math.max(maxLive.get(t.id) ?? 0, counts[i] ?? 0)));
}, 50);

console.log(
  `Load: ${rate} calls/s for ${duration} s against ${apiUrls.join(', ')} (number ${e164}, 5 targets in 3 tiers)`,
);
const inflight: Promise<void>[] = [];
const started = performance.now();
let launched = 0;
while (performance.now() - started < duration * 1000) {
  const due = Math.floor(((performance.now() - started) / 1000) * rate);
  while (launched < due) {
    launched++;
    inflight.push(
      oneCall().catch(() => {
        failures++;
      }),
    );
  }
  await sleep(5);
}
await Promise.all(inflight);
const wall = (performance.now() - started) / 1000;
clearInterval(sampler);

// ── Report ──────────────────────────────────────────────────────────────────
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN) : NaN;
};
const row = (name: string, xs: number[]) =>
  `${name.padEnd(16)} ${String(xs.length).padStart(6)}   p50 ${pct(xs, 50).toFixed(1).padStart(6)}   p95 ${pct(xs, 95).toFixed(1).padStart(6)}   p99 ${pct(xs, 99).toFixed(1).padStart(6)}   max ${Math.max(
    ...xs,
  )
    .toFixed(1)
    .padStart(6)} ms`;

const legs = await sql<{ name: string; legs: number }[]>`
  select t.name, count(l.id)::int as legs from targets t left join call_legs l on l.target_id = t.id
  where t.campaign_id = ${campaign!.id} group by t.name order by t.name`;
const [dup] = await sql<{ n: number }[]>`
  select count(*)::int as n from (select l.call_id, l.target_id from call_legs l join calls c on c.id = l.call_id
   where c.org_id = ${orgId} group by 1, 2 having count(*) > 1) d`;
const capViolations = targets.filter((t) => (maxLive.get(t.id) ?? 0) > t.cc);

console.log('');
console.log(
  `calls started: ${launched} in ${wall.toFixed(1)} s (${(launched / duration).toFixed(1)} calls/s offered), dial attempts: ${attemptsTotal}, request failures: ${failures}`,
);
console.log(
  `outcomes: ${Object.entries(outcomes)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
console.log('');
console.log(row('/voice/inbound', latency.inbound));
console.log(row('/voice/result', latency.result));
console.log(row('all webhooks', [...latency.inbound, ...latency.result]));
console.log('');
console.log('target  tier  cc cap  max live seen  legs');
for (const t of targets) {
  const spec = specs.find((s) => s.name === t.name)!;
  console.log(
    `${t.name.padEnd(7)} ${String(spec.tier).padStart(4)}  ${String(t.cc).padStart(6)}  ${String(maxLive.get(t.id) ?? 0).padStart(13)}  ${String(legs.find((l) => l.name === t.name)?.legs ?? 0).padStart(4)}`,
  );
}
console.log(
  `\nrepeat rings of a target on one call: ${dup?.n ?? 0}; cap violations: ${capViolations.length}`,
);

if (values.json) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    values.json,
    JSON.stringify(
      {
        rate,
        duration,
        launched,
        attempts: attemptsTotal,
        failures,
        outcomes,
        latencyMs: Object.fromEntries(
          (['inbound', 'result'] as const).map((k) => [
            k,
            {
              n: latency[k].length,
              p50: pct(latency[k], 50),
              p95: pct(latency[k], 95),
              p99: pct(latency[k], 99),
              max: Math.max(...latency[k]),
            },
          ]),
        ),
        targets: targets.map((t) => ({
          name: t.name,
          ccCap: t.cc,
          maxLive: maxLive.get(t.id) ?? 0,
          legs: legs.find((l) => l.name === t.name)?.legs ?? 0,
        })),
        repeatRings: dup?.n ?? 0,
      },
      null,
      2,
    ),
  );
}

if (!values.keep) {
  await sql`delete from calls where org_id = ${orgId}`;
  await sql`delete from phone_numbers where org_id = ${orgId}`;
  await sql`delete from organizations where id = ${orgId}`;
  await redis.del(...targets.map((t) => keys.live(t.id)), keys.route(e164));
}
await close();
redis.disconnect();

const p95s = [pct(latency.inbound, 95), pct(latency.result, 95)];
const pass =
  failures === 0 && capViolations.length === 0 && (dup?.n ?? 0) === 0 && p95s.every((p) => p < 300);
console.log(
  pass ? '\nPASS: every webhook p95 < 300 ms, no cap exceeded, no double ring' : '\nFAIL',
);
process.exit(pass ? 0 : 1);
