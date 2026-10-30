<!-- Product and architecture plan. Source of truth for product intent; see DECISIONS.md for what was built and why. -->

Call Forwarding Portal — Build Roadmap
Reference product: callflow.solutions — a US toll-free / local number forwarding and pay-per-call routing platform. What we're building: a portal where a customer gets a phone number, points it at one or more destination numbers (phone, SIP, or later browser agent), and every inbound call is routed, logged, recorded and billed from one dashboard. Status: Planning only. No application code is written until the decisions in §13 are confirmed.

0. TL;DR
Question	Answer
Smallest sellable product	Sign up → buy a number → set a destination → calls forward → see call logs
MVP timeline	~6–7 weeks with 2 full-stack engineers (Phases 0–2)
First revenue	~10–11 weeks (adds wallet, Stripe, itemized billing — Phase 3)
Full parity with the reference	~20 weeks with 2 engineers + part-time designer (Phases 0–6)
Recommended stack	Next.js + Fastify (TypeScript) + Postgres + Redis + BullMQ; Telnyx primary, Twilio secondary
Hardest part	Not the UI — it's the routing decision under load (caps, weights, failover) and carrier reliability
Biggest risks	Toll-free spam labeling, fraud/IRSF, webhook latency, E911/recording compliance
Rule of thumb: if you only need 1–5 numbers forwarded, use the carrier directly or a hosted PBX. Building this is justified when you need a multi-tenant portal, buyer/partner routing, wallet billing, or a white-label product.

1. What we are building
1.1 One-liner
Get a toll-free or local number, forward every call to the phone, SIP trunk or agent that should answer, and watch routing, recordings and spend live in one portal.

1.2 The core journey (must work end-to-end before anything else)
Sign up → account + organisation created, 14-day trial credit.
Buy a number → search live inventory by prefix/digits, purchase, number is active in seconds.
Set forwarding → destination number, ring timeout, optional business hours, optional failover number.
A call arrives → carrier hits our webhook, router picks a destination, call is bridged, caller ID passed through.
See it → call appears in the log within seconds: caller, number dialled, destination, duration, outcome, cost.
Everything else in the product is an elaboration of step 3 and step 5.

1.3 Two product shapes — build the data model for B, ship the UX of A
Shape A — Simple forwarder	Shape B — Pay-per-call routing platform
User	Small business	Call centre, lead buyer/seller, performance marketer
Core object	Number → destination	Number → campaign → weighted targets
Money	Flat monthly / per-minute	Prepaid wallet, buy/sell margin, itemized
Complexity	Low	High (caps, tiers, buyers, payouts)
The reference product is Shape B. Trying to bolt campaigns, caps, buyers and a wallet onto a Shape A schema later is a rewrite. So: schema for B, UI for A, then unlock B phase by phase.

1.4 Reference teardown — what callflow.solutions actually ships
Observed from the live site and its developer docs:

Area	What they built
Marketing site	React SPA (Vite build, hashed index-*.js / landing-*.js assets), Tailwind, light/dark theme, blog + free number-lookup tool for SEO
Product surfaces	Customer portal (owner/admin/member), buyer portal (scoped login), browser-agent answering, admin back-office
Numbers	US toll-free (800/833/844/855/866/877/888) + local DIDs, live inventory search by prefix and digits, instant provisioning, self-serve release
Routing	Priority tiers → eligibility filter → weights scaled by capacity headroom → ring time → no-answer failover → hold queue; sequential or simultaneous ringing
Targets	Phone, SIP (sip:{did}@host:port), browser agents / extension groups
Caps	Concurrent, hourly, daily, total — each resets automatically
Protection	STIR/SHAKEN policy, per-caller rate limits, blocklist, block VoIP/international, press-a-digit IVR with random digit challenge
Campaigns	Own the numbers, routing mode, ring time, duplicate-caller policy + look-back window, IVR config, queue
Recording	Per-call, 10-day default retention, playback, consent
Live ops	"Mission Control" — active calls, duration, routing decision, accruing cost
Billing	Prepaid wallet, itemized ledger, buy/sell price for margin, no subscription
Reporting	Period dashboard, answer rate, minutes, AHT, completed/missed/failed, unique vs repeat, CSV/XLSX export
Buyer features	Buyer sees only own calls/recordings/targets/wallet; tracking numbers can be hidden; scheduled email reports
Integrations	REST API /api/v1 (versioned, cf_live_… bearer keys), signed webhooks (call.started, call.completed, call.recording_ready, call.disposition_updated) with HMAC + retries, Zapier / GoHighLevel / n8n
Compliance posture	Published privacy/terms/AUP, legal-request process, 10-day recording expiry, signed webhooks, RBAC, session auth
Implication: the visible product is a CRUD dashboard; the defensible part is the router + money + carrier relationships. Build those as first-class services from day one.

1.5 Non-goals for v1 (write these down, then defend them)
❌ Browser/WebRTC agent answering (Phase 5)
❌ Marketplace / call offers (Phase 5+)
❌ AI routing that "learns" (Phase 5; start with deterministic weights)
❌ SIP targets (Phase 5; phone targets only in MVP)
❌ International numbers beyond US/CA (Phase 6+)
❌ Native mobile app
❌ E911 dispatch (see §8 — must be explicitly excluded or handled via provider)
❌ White-label / custom domains (later)
2. Architecture
2.1 Three planes
Plane	Responsibility	Failure impact
Voice path	Carrier webhook → routing decision → dial instruction	Calls fail — highest priority
Control plane	Portal, REST API, auth, config	Users can't change settings; calls keep flowing on cached routes
Data plane	CDRs, recordings, ledger, webhooks out	Billing/reporting lag; calls unaffected
The voice path must never depend on a cold Next.js page or a slow DB query. It is a separate, always-warm service.

2.2 Diagram
Code block


flowchart LR
  C[Caller] -->|PSTN| P[Carrier / CPaaS<br/>Telnyx or Twilio]
  P -->|voice webhook| R[Router API<br/>Fastify + Zod]
  R <-->|route cache · live legs · caps<br/>rate limits · call sessions| REDIS[(Redis)]
  R -->|TwiML / TeXML| P
  P -->|bridged leg| T1[Phone]
  P -->|bridged leg| T2[SIP / PBX]
  P -->|bridged leg| T3[Browser agent]
  P -->|status + recording webhooks| W[Worker<br/>BullMQ]
  W --> PG[(Postgres)]
  W --> S3[(S3 / R2 recordings)]
  W -->|signed webhooks| CRM[Customer CRM]
  W -->|metering| L[Wallet ledger]
  WEB[Next.js portal] --> API[REST API v1]
  API --> PG
  API --> REDIS
  API --> STRIPE[Stripe]
Port/process layout:

apps/web — Next.js portal + marketing site
apps/api — Fastify REST API and the carrier voice webhooks (same deploy, separate route group)
apps/worker — BullMQ consumers: CDR finalisation, recording fetch + retention, metering, webhook delivery, emails, scheduled reports
packages/db, packages/core (routing, billing, provider adapters), packages/ui
2.3 Inbound call sequence
Code block


sequenceDiagram
  participant C as Caller
  participant P as Carrier
  participant R as Router
  participant D as Destination
  C->>P: dials +1 833 555 0142
  P->>R: POST /voice/inbound (CallSid, From, To, attestation)
  R->>R: load route from cache · protection checks
  R->>R: pick target (tier → eligible → weighted)
  R-->>P: <Dial timeout=25 action=/voice/result>...</Dial>
  P->>D: INVITE / PSTN
  D-->>P: 200 OK
  P->>R: POST /voice/result (DialCallStatus, duration)
  R->>R: write CDR · enqueue metering + webhooks
  R-->>P: 204 / empty TwiML
Key constraints:

Carrier expects the instruction response in < 5 seconds (Twilio hard timeout ~15s but answer-rate suffers after ~2s). Target p95 < 300ms.
Carrier webhooks retry — every handler must be idempotent on provider call id + event.
The action callback fires after the dial attempt completes; sequential failover is implemented by returning the next <Dial> from that callback. State (which targets were tried) lives server-side in Redis keyed by call id — never trust query params.
For Twilio, answerOnBridge="true" avoids a silent gap before the destination answers.
2.4 Latency budget
Hop	Budget (p95)
Carrier → our webhook	250 ms
Route cache lookup (Redis)	5 ms
Protection + eligibility + pick	20 ms
Response write	25 ms
Total webhook	300 ms
Post-dial delay (caller perspective)	< 2 s
Deploy the API in the carrier's home region (US East for Twilio, US Central for Telnyx) and keep the route cache warm.

2.5 Provider strategy
One TelephonyProvider interface: searchNumbers, purchaseNumber, releaseNumber, configureWebhook, buildDial, hangup, startRecording, fetchRecording, verifySignature.
Implement Telnyx and Twilio adapters; ship one in MVP, keep the other as a stub with contract tests.
Store provider + provider_ref per number so a number can be migrated without schema change.
Phase 5 adds health checks and automatic failover at the number level.
3. Tech stack
Layer	Choice	Why	Alternative
Web	Next.js 15 (App Router) + TypeScript	SEO marketing site + app in one repo	Remix, SvelteKit
UI	Tailwind + shadcn/ui + Recharts + TanStack Table/Query	Fast, consistent, accessible	MUI, Chakra
API	Fastify + Zod + OpenAPI	Low overhead, schema-validated, easy to keep warm	NestJS, Hono
DB	Postgres 16 + Drizzle ORM (SQL-first)	Relational fits billing/CDR; raw SQL for atomic ops	Prisma, Kysely
Cache/state	Redis 7	Route cache, live leg counts, caps, rate limits, sessions	Valkey, KeyDB
Queue	BullMQ	Retries, backoff, scheduled jobs	SQS + Lambda
Auth	Self-hosted sessions (Argon2id + httpOnly cookies) + TOTP	Multi-tenant roles + buyer portal need custom scoping; no per-MAU cost	Clerk, Auth.js
Payments	Stripe Checkout + webhooks	PCI offloaded	Paddle
Files	S3-compatible (AWS S3 / Cloudflare R2) + lifecycle rules	Recording retention	GCS
Email	Resend / Postmark	Transactional + reports	SES
Observability	OpenTelemetry + Grafana/Axiom + Sentry + PagerDuty	Trace a call end-to-end	Datadog
Infra	Docker + Fly.io or AWS ECS/RDS; Cloudflare in front	Small team velocity	Render, Railway
Tests	Vitest, Testcontainers, Playwright, k6	Unit + integration + E2E + load	—
Monorepo	pnpm + Turborepo	Shared types across web/api/worker	Nx
Why split web and api: the voice webhook must scale and deploy independently of the marketing site, must stay warm (no serverless cold starts), and must not be blocked by a frontend deploy. This is the single most important structural decision.

4. Data model
Full DDL lives in BUILD_PROMPT.md. Entity map:

Entity	Purpose	Key fields
organizations	Tenant	name, timezone, currency, wallet balance (micros), status, settings
users	Login identity	email, password hash, MFA
memberships	User ↔ org + role	owner / admin / member / buyer / agent
sessions	Server-side sessions	hashed token, expiry, IP
phone_numbers	Owned DIDs	e164, country, type, provider, status, campaign, buy/sell price
campaigns	Routing container	routing mode, ring timeout, IVR, duplicate policy, recording
targets	Destinations	type, destination, weight, priority tier, CC/hourly/daily/total caps, enabled
schedules / schedule_windows	Opening hours	timezone, weekday, open/close (cross-midnight), dated windows
calls	CDR header	from, to, number, campaign, target, timings, outcome, cost, revenue, repeat flag
call_legs	One row per attempt	attempt no, target, start/end, outcome, SIP code
recordings	Audio	storage key, duration, expires_at, deleted_at
wallet_entries	Append-only ledger	kind, amount micros, balance_after, idempotency ref
blocklist_entries	Blocked callers	e164, reason, author
api_keys, webhook_endpoints, webhook_deliveries	Integrations (Phase 4)	hashed key, events, retries
audit_logs	Who changed what	actor, action, entity, before/after
Rules:

Every tenant-owned row carries org_id, and every query is scoped by it. Add a lint/test that fails on unscoped queries.
Money is integer micros (1 USD = 1,000,000). No floats, ever.
Timestamps are timestamptz in UTC; display in the org's timezone.
calls is append-only at the application level; corrections are new rows/fields, not silent updates.
Indexes: (org_id, started_at desc), (provider_call_id), (campaign_id, from_e164, started_at desc) for repeat detection.
Redis keys (the hot path)
Key	Type	TTL	Purpose
route:{e164}	JSON	5 min	Compiled campaign + ordered targets
cc:{targetId}	integer	ring + 60 s	Live concurrent legs
cap:h:{targetId}:{YYYYMMDDHH}	integer	2 h	Hourly usage
cap:d:{targetId}:{YYYYMMDD}	integer	3 d	Daily usage
cap:t:{targetId}	integer	none	Total usage
rl:{orgId}:{fromE164}	integer	60 s / 1 h	Per-caller rate limits
call:{providerCallId}	JSON	1 h	Routing session: tried targets, tier pointer
sess:{tokenHash}	JSON	30 d	Auth session
Postgres is the source of truth; Redis is a fast projection. A reconciliation job re-syncs counters and releases orphaned reservations every minute.

5. Routing engine (the heart)
5.1 Rules, in order
Find the route by dialled number (cache → DB).
Campaign active? No → play "number not in service" / hang up.
Protection, before anything rings:
STIR/SHAKEN attestation policy (e.g. require A or B);
per-caller rate limit (per minute / per hour);
blocklist match;
optional block-all-VoIP / block-all-international;
optional press-a-digit IVR (random digit challenge).
Walk priority tiers ascending. A tier is skipped only when every target in it is ineligible.
Eligibility filter: enabled, not already tried on this call, inside schedule, under concurrent cap, under hourly/daily/total caps.
Weighted pick inside the tier, where effective weight = weight × (1 − concurrent/cap) × answerRateFactor.
Atomically reserve the slot (Lua: check + increment CC, check caps) before dialling.
Ring for the campaign ring time.
On no answer / busy / failed: release the slot, mark tried, go to step 4 with the remaining targets, then next tier.
Exhausted: hold queue (music + retry every 15 s up to 120 s) → overflow number → voicemail → hang up.
On answer: talk timer starts; on hangup write leg + CDR, meter, release slot.
5.2 Pseudocode
ts


async function onInbound(call: InboundCall): Promise<DialPlan> {
  const route = await routeCache.get(call.to);            // Redis → Postgres fallback
  if (!route?.enabled) return hangup('unallocated');

  const verdict = await protection.evaluate(call, route); // attestation, rate limit, blocklist
  if (verdict.blocked) return hangup(verdict.reason);

  if (route.ivr?.enabled && !call.ivrPassed) return ivr(route);

  const session = await sessions.create(call, route);     // Redis, TTL 1h
  return attempt(session, 0);
}

async function attempt(session: CallSession, tierIndex: number): Promise<DialPlan> {
  for (let i = tierIndex; i < session.tiers.length; i++) {
    const eligible = session.tiers[i].filter(t => isEligible(t, session));
    if (!eligible.length) continue;

    const target = await reserveWeighted(eligible);       // Lua: pick + atomic check + reserve
    if (!target) continue;

    session.tried.add(target.id);
    return dial(target, session.route.ringTimeoutSec, () => attempt(session, i));
  }
  return session.route.queue?.enabled ? enqueue(session) : voicemailOrBusy(session);
}

function isEligible(t: Target, s: CallSession): boolean {
  return t.enabled
    && !s.tried.has(t.id)
    && inSchedule(t, s.now, t.timezone)
    && cc(t.id) < t.ccCap
    && underHourlyDailyTotal(t);
}
reserveWeighted runs as a single Redis Lua script: builds cumulative effective weights, picks one, verifies CC and caps atomically, increments counters, sets a reservation TTL of ringTimeout + 60 s. Retry up to 3 times if a race loses.

5.3 Edge cases to design for (each one is a test)
Case	Behaviour
All targets closed / at cap	Hold queue, then overflow, then after-hours message
Caller hangs up during ring	Release reservation via status webhook + reaper
Target answers then transfers	Keep original CDR; transfer is a new leg, not a new call
Duplicate carrier webhook	Idempotent on (provider, provider_call_id, event)
Carrier webhook arrives twice with different status	Last state wins, but never duplicate the ledger entry
Target rings twice on one call	tried set prevents it
Redis down	Degrade to DB-only routing with a static fallback number; alert loudly
DST / cross-midnight schedule	Store windows in target timezone; evaluate with a real tz library (Luxon/Temporal)
Repeat caller policy	normal / same_buyer / different_buyer within look-back days
Simultaneous ring	Ring all eligible in tier; first answer wins; cancel the rest
Fraud burst (IRSF)	Velocity + destination allowlist + spend cap + auto-suspend
5.4 What "good" looks like
10,000 simulated calls across 3 tiers with caps: zero cap violations, zero double-rings, distribution within ±3% of configured weights.
p95 routing response < 300 ms under 100 calls/s.
A target at its CC cap receives no call, even at 50 concurrent requests.
6. Billing & metering
Two legs are billed: inbound (caller → number) and outbound (number → destination). Reference product bills "minutes routed".
Increments: configurable per org; default 60/60, minimum 60 s. billed = ceil(max(talk, 1) / inc) * inc.
Rate card: per number type (toll-free/local), per destination country, per target (buy price / sell price). Revenue − cost = margin, visible per call and per campaign.
Wallet: prepaid, append-only ledger, balance materialised on organizations. Debit on call.completed; idempotency key (call_id, leg).
Authorisation: on inbound, if balance < one-minute estimated cost → play "account issue" and block (configurable grace).
Top-ups: Stripe Checkout → webhook checkout.session.completed → credit entry. Auto-recharge threshold + amount per org.
Number rental: monthly fee debited from the wallet on the purchase anniversary (prorated first month).
Refunds/adjustments: new ledger rows only, never edits.
Reconciliation: nightly job compares carrier invoices/CDRs to our ledger; mismatch report to admin.
7. Compliance & security
7.1 Telephony compliance (US-first)
Item	Requirement
Toll-free verification (TFV)	Submit business identity to carriers; without it, calls get "Spam Likely" labeled or blocked
STIR/SHAKEN	Carriers sign; we read attestation and enforce a policy
TCPA	Consent, calling windows, DNC; AUP forbids illegal robocalling
E911	Local DIDs have E911 obligations. MVP must either use the provider's E911 service or explicitly state "not for emergency calls" and restrict use
Recording consent	Federal one-party; ~11 states two-party. Announcement + per-campaign toggle + retention default 10 days
KYC/KYB	Identity/business verification before number purchase; OFAC screening
Porting	LOA + FOC process; number port-in/port-out runbook
Data	GDPR/CCPA: DPA, retention policy, deletion requests, sub-processor list
Abuse	Published AUP, traceback response process, suspension workflow, law-enforcement request policy
PCI	Card data never touches our servers (Stripe Checkout/Elements)
7.2 Application security
Argon2id passwords, optional TOTP MFA, session rotation on login.
httpOnly + Secure + SameSite=Lax cookies; CSRF protection on state-changing routes.
RBAC enforced server-side on every route (not just hidden UI).
API keys hashed at rest, shown once, scoped, revocable.
Webhook URLs validated (HTTPS only, no private IPs/localhost — SSRF guard).
HMAC-SHA256 webhook signatures with timestamp + replay window; x-event-id for dedupe.
Rate limiting per IP, per user, per key; login lockout.
Secrets in a manager (Fly secrets / AWS Secrets Manager), never in repo.
Audit log for admin actions, impersonation, refunds, number release.
Encrypted backups + tested restore; PITR on Postgres.
Dependency scanning + pnpm audit in CI; OWASP ZAP baseline before launch.
8. Roadmap
8.1 Phase overview
Phase	Duration	Cumulative	Outcome	Exit gate
0 — Decisions & spike	3–5 days	wk 0.5	Carrier chosen, real call rings a phone	Spike works end-to-end
1 — Walking skeleton	2.5 wks	wk 3	Auth, numbers, one-destination forwarding, call logs	Demo to a stranger
2 — Routing engine	3.5 wks	wk 6.5	Campaigns, tiers, weights, caps, failover, IVR, protection	Load + property tests pass
3 — Money & visibility	3 wks	wk 9.5	Wallet, Stripe, recordings, reports, margin	First paying customer
4 — Multi-user & integrations	3 wks	wk 12.5	Buyer portal, REST API, signed webhooks, scheduled reports	Partner onboarding
5 — Scale & differentiation	4 wks	wk 16.5	Multi-provider, SIP, browser agents, queue, admin	Provider failover drill
6 — Harden & launch	2 wks	wk 18.5	Pen-test fixes, load test, runbooks, launch	7 days at SLO
Estimates assume 2 full-stack engineers, 0.5 designer, 0.25 DevOps, and a decisive product owner. Add 20% buffer.

8.2 Phase 0 — Decisions & spike (3–5 days)
Pick primary carrier; open sandbox; verify toll-free + local inventory and pricing.
Confirm target market (US only? US+CA?), toll-free vs local, buyer/pay-per-call in scope.
Entity, Stripe account, domain, legal pages outline.
Spike: 50-line script — inbound webhook returns a <Dial> to a real phone. Measure latency.
Done when: a real call to a sandbox number rings a real phone, and the webhook response time is measured and recorded.
8.3 Phase 1 — Walking skeleton (2.5 weeks)
Monorepo, CI (lint/typecheck/test/build), docker-compose (Postgres, Redis, MinIO, mailhog), migrations, seed.
Auth: register, login, logout, password reset, org creation, invite, roles.
Numbers: live inventory search, purchase, list, detail, release — via MockProvider in dev, real carrier when keys present.
Forwarding: per-number destination + ring timeout + enabled toggle (internally creates the default campaign + target).
Voice webhook: signature verification, number lookup, dial, status callback, CDR write.
Call logs table: filters (date, outcome, number), row detail, pagination.
Dashboard v1: calls, minutes, answer rate, 7/30-day chart.
Audit log v1, settings (org name, timezone).
Done when: a new signup can buy a (mock or real) number, set a mobile destination, call it, and see the call with duration and outcome within 5 seconds; pnpm test and pnpm e2e green.
8.4 Phase 2 — Routing engine (3.5 weeks)
Campaigns CRUD; attach multiple numbers; pause campaign.
Targets: phone (SIP later), weight, priority tier, CC/hourly/daily/total caps, schedules (daily + dated, cross-midnight), enable/disable.
Sequential + simultaneous ringing; no-answer/busy failover; tried set.
Redis routing state + Lua reservation; reaper for orphaned legs; DB reconciliation job.
IVR press-a-digit (per campaign, custom prompt, random digit challenge).
Call protection: attestation policy, per-caller rate limits, blocklist, block VoIP/international.
Live calls view (poll or SSE), call detail with per-attempt leg timeline.
Property-based routing tests + k6 load test.
Done when: 10k simulated calls show zero cap violations; failover demo works across 3 tiers; p95 < 300 ms at 100 calls/s.
8.5 Phase 3 — Money & visibility (3 weeks)
Recording: per-campaign toggle, consent announcement, storage, 10-day retention job, playback.
Wallet + ledger + Stripe Checkout top-up + auto-recharge + low-balance email.
Metering worker: billed seconds per leg, cost/revenue, idempotent ledger entries.
Dashboard v2: period filter, daily chart, completed/missed/failed, AHT, per-campaign table, unique vs repeat.
Revenue page: buy/sell price per number/target, margin per call and campaign.
CSV/XLSX exports (calls, ledger).
Done when: every call has cost + revenue; wallet balance equals the ledger sum; Stripe test-mode top-up credits correctly; export matches UI totals.
8.6 Phase 4 — Multi-user & integrations (3 weeks)
Buyer accounts + buyer portal (own calls, live calls, recordings if allowed, own targets/wallet), hide tracking numbers.
REST API v1 + hashed API keys + scopes + OpenAPI docs + quickstart.
Webhooks: endpoints, event types, HMAC signatures, retries with backoff, delivery log, "send test event".
Zapier / GoHighLevel / n8n recipes; dispositions (Sale, Callback, …).
Scheduled email reports per buyer.
Done when: tenant-isolation tests prove a buyer can never read another org's rows; a signed test event verifies on a sample server; a failed endpoint retries with backoff and appears in the delivery log.
8.7 Phase 5 — Scale & differentiation (4 weeks)
TelephonyProvider second adapter + per-number provider + health checks + failover runbook.
SIP targets (host/port, dialled DID as SIP user part).
Browser agents (WebRTC SDK), extension groups, simultaneous ring.
Hold queue / overflow with music; answer-rate EWMA "AI routing".
Admin back-office: accounts, fraud queue, refunds, provider ops, audited impersonation.
Marketplace/offers (only if demand is proven).
Done when: killing the primary provider fails a number over to the secondary in < 60 s; a SIP call to FreeSWITCH works; an agent answers in the browser.
8.8 Phase 6 — Harden & launch (2 weeks)
Pen-test remediation, dependency update, secret rotation drill.
Load test at 10× forecast; DR restore drill; chaos: kill Redis, delay/drop carrier webhooks.
Runbooks (on-call, incident, carrier outage, fraud, number port), status page, alerting.
Docs: customer help centre, API reference, changelog.
Legal pages published; TFV submissions filed.
Private beta (5–10 customers), fix, then public launch.
Done when: 7 consecutive days meeting SLOs, no P0/P1 open, restore tested, legal pages live.
8.9 MVP cut line
After phase	You can honestly sell…
2	"Forward your number with smart routing and call logs"
3	"…and pay as you go from a wallet"
4	"…and give buyers/partners their own login"
5	"…and answer in the browser / connect your PBX"
9. Team, cost, unit economics
9.1 Team
Role	Allocation	Notes
Full-stack engineer ×2	100%	One owns voice/routing, one owns portal/billing
Designer	50%	Design system + core screens; marketing later
DevOps/SRE	25%	Infra, observability, on-call
Product/founder	50%	Scope, pricing, carrier contracts, compliance
9.2 Running costs (early stage, approximate — verify with carriers)
Item	Monthly
App + API + worker hosting	$80–250
Postgres (managed)	$25–80
Redis	$10–40
Object storage (recordings)	$5–30
Email, monitoring, Sentry	$40–100
Domain, Cloudflare	$0–25
Infra subtotal	~$160–525
Number rental (per DID)	~$1–2
Inbound toll-free usage	~$0.015–0.03 / min
Outbound US termination	~$0.007–0.014 / min
Stripe	2.9% + $0.30
9.3 Unit economics example (illustrative)
Line	Buy	Sell	Margin
Toll-free number / month	$1.50	$4.99	70%
Inbound / min	$0.022	$0.045	51%
Forwarding leg / min	$0.009	$0.020	55%
Recording storage / min	$0.001	$0.005	80%
At 20 customers × 5 numbers × 3,000 min/month ≈ $4–6k revenue, $2.5–3.5k gross profit before infra and salaries. The business works on volume and on the buy/sell spread, not on subscriptions.

10. Testing, observability, SLOs
10.1 Testing pyramid
Level	What
Unit	Routing eligibility, weights, caps, schedules/DST, billing rounding, duplicate policy (Vitest)
Property-based	fast-check: caps never exceeded, no target rung twice, only eligible targets, tier order respected
Integration	API + Postgres + Redis via Testcontainers; carrier adapter contract tests with recorded fixtures
E2E	Playwright: signup → buy (mock) → forward → simulated call → CDR appears
Load	k6: 100 calls/s webhook, 1k concurrent reservations; Lua script benchmarks
Chaos	Kill Redis, duplicate webhooks, delay carrier callbacks, DB failover
Security	ZAP baseline, dependency audit, tenant-isolation tests, SSRF checks
10.2 SLOs
Metric	Target
Voice webhook availability	99.95%
Routing response p95	< 300 ms
API p95	< 200 ms
Webhook delivery success within 5 min	> 99%
Call setup (post-dial)	< 2 s
Ledger accuracy	100% (nightly reconciliation)
10.3 Dashboards & alerts
Calls/min, answer rate, failed rate, average ring time.
Routing latency histogram, cache hit ratio, Redis ops.
Live legs vs caps, cap-breach counter (should always be 0).
Webhook delivery lag, retry queue depth.
Wallet negative accounts, fraud flags, provider error rate.
11. Risks & mitigations
Risk	Likelihood	Impact	Mitigation
Toll-free numbers labeled "Spam Likely"	High	Kills answer rates	TFV, attestation monitoring, number hygiene, rotate numbers, publish a spam-score tool
Fraud / IRSF / wangiri	Medium	Direct money loss	Destination allowlist, spend caps, velocity checks, KYC, auto-suspend
Webhook latency or carrier outage	Medium	Dropped calls	Warm service, cache, fallback route, second provider, status page
E911 / regulatory exposure	Medium	Legal + fines	Provider E911 or explicit exclusion, AUP, counsel review
Recording consent violations	Medium	Lawsuits	Announcement, state-aware defaults, retention limit
Scope creep (marketplace, AI)	High	Delays MVP	Phase gates; non-goals list in §1.5
Vendor lock-in	Medium	Cost/leverage	Adapter interface, multi-provider by Phase 5
Billing disputes	Medium	Churn	Leg-level CDRs, recordings, itemized ledger, exports
Solo/small-team bus factor	Medium	Stall	Docs, runbooks, pair on voice path
12. Launch checklist
 Real carrier account in production, TFV submitted, number inventory confirmed
 Legal: terms, privacy, AUP, DPA, cookie notice, recording-consent policy
 E911 position documented (enabled or explicitly excluded)
 Stripe live keys, tax handling, refund policy
 Backups + restore drill; secret rotation drill
 Load test at 10× forecast; chaos drills passed
 On-call rotation, alert routing, status page
 Support: help centre, contact form, SLA wording
 Pricing page matches metering reality (no surprises on first invoice)
 Beta feedback triaged; P0/P1 closed
13. Decisions needed before code
#	Decision	Options	Recommendation
1	First build scope	MVP (Ph 0–2) / through billing (0–3) / full parity	Through billing (0–3) — sellable and chargeable
2	Primary carrier	Telnyx / Twilio / SignalWire	Telnyx (cost, SIP, inventory), Twilio as secondary
3	Coverage	US toll-free only / US+CA toll-free+local / global	US toll-free + local first
4	Pay-per-call / buyers in v1?	Yes / later	Later (Phase 4) unless a design partner needs it
5	Recording default	On / off	Off by default, opt-in per campaign with consent announcement
6	E911	Provider E911 add-on / toll-free only	US toll-free only for MVP — do not sell local DIDs until the carrier's E911 service is wired up
7	Brand / domain	—	Needed before Phase 1 UI
8	Team & budget	—	Determines timeline confidence
