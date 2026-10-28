/**
 * Simulate a carrier call against the mock provider, following the router's
 * instructions like a real carrier would: IVR gathers, dial attempts with
 * failover, per-leg status callbacks, and the final parent status.
 *
 *   pnpm simulate-call --to +18005550100 [--from +15551230000]
 *     [--outcomes no-answer,busy,completed]   outcome per dial attempt (last one repeats)
 *     [--duration 42] [--ring 2] [--digit 5] [--stir TN-Validation-Passed-A]
 *     [--hold]                                 leave the call connected (watch it on Live calls)
 *
 * Requires TELEPHONY_PROVIDER=mock on the API.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { loadEnvFile, signMockWebhook } from '@relay/core/server';

loadEnvFile();

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    from: { type: 'string', default: '+15551230000' },
    outcome: { type: 'string' },
    outcomes: { type: 'string', default: 'completed' },
    duration: { type: 'string', default: '42' },
    ring: { type: 'string', default: '2' },
    digit: { type: 'string' },
    stir: { type: 'string' },
    hold: { type: 'boolean', default: false },
    api: { type: 'string' },
    'public-url': { type: 'string' },
    secret: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const OUTCOMES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled']);
if (!values.to) {
  console.error(
    'Usage: simulate-call --to +18005550100 [--outcomes no-answer,completed] [--duration 42]',
  );
  process.exit(2);
}
const plan = (values.outcome ?? values.outcomes).split(',').map((s) => s.trim());
for (const o of plan) {
  if (!OUTCOMES.has(o)) {
    console.error(`Outcomes must be among ${[...OUTCOMES].join(', ')}`);
    process.exit(2);
  }
}

const port = process.env.API_PORT ?? '4000';
const target = (values.api ?? `http://localhost:${port}`).replace(/\/$/, '');
const publicUrl = (values['public-url'] ?? process.env.PUBLIC_API_URL ?? target).replace(/\/$/, '');
const secret = values.secret ?? process.env.MOCK_WEBHOOK_SECRET ?? 'dev-mock-webhook-secret';
const sid = () => `CA${randomBytes(16).toString('hex')}`;
const callSid = sid();
const log = (...args: unknown[]) => {
  if (!values.quiet) console.log(...args);
};

/** POST to a path or an absolute public URL the router handed us. */
async function post(pathOrUrl: string, params: Record<string, string>) {
  const path = pathOrUrl.startsWith('http') ? pathOrUrl.slice(publicUrl.length) : pathOrUrl;
  const body = new URLSearchParams(params).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...signMockWebhook(secret, `${publicUrl}${path}`, body),
  };
  const started = performance.now();
  const res = await fetch(`${target}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  log(
    `POST ${path.split('?')[0]} → ${res.status} (${(performance.now() - started).toFixed(1)} ms)`,
  );
  if (!res.ok) {
    console.error(text);
    process.exit(1);
  }
  return text;
}

const unxml = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseDial(twiml: string) {
  const action = /<Dial[^>]*action="([^"]+)"/.exec(twiml)?.[1];
  if (!action) return null;
  const numbers = [
    ...twiml.matchAll(/<Number(?: [^>]*statusCallback="([^"]+)")?[^>]*>([^<]+)<\/Number>/g),
  ].map((m) => ({
    destination: m[2]!,
    legUrl: m[1] ? unxml(m[1]) : null,
    legSid: sid(),
  }));
  return { action: unxml(action), numbers };
}

log(
  `Simulating call ${callSid}: ${values.from} → ${values.to} (attempt outcomes: ${plan.join(' → ')})`,
);
let twiml = await post('/voice/inbound', {
  CallSid: callSid,
  From: values.from,
  To: values.to,
  CallStatus: 'ringing',
  Direction: 'inbound',
  ...(values.stir ? { StirVerstat: values.stir } : {}),
});

const gather = /<Gather[^>]*action="([^"]+)"[^>]*><Say>([^<]*)<\/Say>/.exec(twiml);
if (gather) {
  const prompt = unxml(gather[2] ?? '');
  const digit = values.digit ?? /press (\d)/i.exec(prompt)?.[1] ?? '';
  log(`IVR: "${prompt}" → pressing ${digit || '(nothing)'}`);
  twiml = await post(unxml(gather[1]!), { CallSid: callSid, Digits: digit });
}

let attempt = 0;
let finalStatus = 'completed';
for (let dial = parseDial(twiml); dial; dial = parseDial(twiml)) {
  const outcome = plan[Math.min(attempt, plan.length - 1)]!;
  attempt++;
  log(
    `Attempt ${attempt}: ringing ${dial.numbers.map((n) => n.destination).join(', ')} → ${outcome}`,
  );
  for (const n of dial.numbers)
    if (n.legUrl)
      await post(n.legUrl, { CallSid: n.legSid, ParentCallSid: callSid, CallStatus: 'ringing' });
  await sleep(Number(values.ring) * 1000);

  const winner = outcome === 'completed' ? dial.numbers[0] : undefined;
  if (winner?.legUrl) {
    await post(winner.legUrl, {
      CallSid: winner.legSid,
      ParentCallSid: callSid,
      CallStatus: 'in-progress',
    });
  }
  for (const n of dial.numbers) {
    if (n === winner || !n.legUrl) continue;
    const legStatus = outcome === 'completed' || outcome === 'canceled' ? 'canceled' : outcome;
    await post(n.legUrl, { CallSid: n.legSid, ParentCallSid: callSid, CallStatus: legStatus });
  }
  if (winner && values.hold) {
    log('Connected. Leaving the call up (--hold). Check Live calls; press Ctrl+C to stop.');
    process.exit(0);
  }
  if (winner?.legUrl) {
    await post(winner.legUrl, {
      CallSid: winner.legSid,
      ParentCallSid: callSid,
      CallStatus: 'completed',
      CallDuration: values.duration,
    });
  }
  twiml = await post(dial.action, {
    CallSid: callSid,
    DialCallSid: winner?.legSid ?? '',
    DialCallStatus: outcome,
    DialCallDuration: winner ? values.duration : '0',
  });
  if (outcome === 'canceled') finalStatus = 'canceled';
}

const said = /<Say>([^<]*)<\/Say>/.exec(twiml)?.[1];
if (said) log(`Caller hears: "${unxml(said)}"`);
if (twiml.includes('<Reject')) log('Call rejected (blocked by call protection).');
await post('/voice/status', { CallSid: callSid, CallStatus: finalStatus });
log('Done. The call is in the call log.');
