# Decisions

Assumptions, deviations from `BUILD_PROMPT` (Phase 1) and deferred work. One line of rationale each.
The roadmap wins on product intent; the build prompt wins on implementation order and scope.

## Product scope

- **D1. Twilio is the real carrier; Telnyx is a stub.** Chosen by the product owner for the fastest first integration. `TelnyxProvider` satisfies the interface, throws `NotImplementedError`, and documents the TeXML/Call Control mapping in its header comment. Swap with `TELEPHONY_PROVIDER`.
- **D2. US toll-free only.** Roadmap §13 #6: do not sell local DIDs until the carrier's E911 service is wired up. `number_type = 'local'` stays in the schema; `GET /numbers/available?type=local` and buying a non-toll-free number return 422. The landing page states numbers do not connect to 911.
- **D3. Calls to a number with forwarding off are logged.** Outcome `rejected`, `hangup_cause` = `not_configured` / `org_inactive`, so owners can see missed traffic. Calls to unknown numbers are not logged (no organisation to attribute them to).
- **D4. `GET /api/v1/org/members` added** (owner/admin). The settings page requires a members list and the prompt lists no endpoint for it.
- **D5. `GET /api/v1/dashboard/summary` also accepts `days`.** "Last N days" must start at local midnight in the org timezone; computing that server-side avoids timezone maths in the browser. `from`/`to` still work and take precedence.
- **D6. A number cannot forward to itself.** That would loop the carrier; rejected with 422.

## Architecture & data

- **D7. Hand-written SQL migrations with a 40-line runner** (`packages/db/src/migrate.ts`) instead of `drizzle-kit generate`. `0001_init.sql` is the prompt's DDL verbatim, so it is reviewable against the spec line by line; Drizzle (`schema.ts`) mirrors it for typed queries. Runner is forward-only, transactional, advisory-locked.
- **D8. `0002_phase1_support.sql` adds indexes**, including a unique `(call_id, attempt)` on `call_legs` so a retried inbound webhook can never add a second leg.
- **D9. Two Postgres clients per process.** Drizzle installs its own date parsers on the `postgres` client it wraps, which turns timestamps into strings for raw SQL. Raw hot-path queries use a separate client that returns `Date`/`BigInt`.
- **D10. JSON parameters are sent as `$n::text::jsonb`.** `postgres` otherwise double-encodes a pre-stringified value into a JSON string scalar.
- **D11. The browser reaches the API through a Next.js rewrite of `/api/v1/*`.** Session and CSRF cookies stay first-party on the web origin; the API still enforces strict CORS for direct calls.
- **D12. Sessions live in Postgres only** (the prompt's `sessions` table), not the roadmap's Redis `sess:*` projection. One indexed lookup per request is cheap; sliding expiry is written at most once a day.
- **D13. Password-reset tokens live in Redis** (`pwreset:{sha256}`, 1 h TTL, single use via `GETDEL`). The DDL has no table for them; a reset also deletes all of the user's sessions.
- **D14. Provider interface additions:** `buildMessageAndHangup`, `buildEmptyResponse`, `responseContentType`, plus a shared `parseVoiceParams`. Twilio, Telnyx TeXML and the mock all post TwiML-style fields (`CallSid`, `DialCallStatus`, …), so one parser serves all three.
- **D15. Mock webhook auth = HMAC-SHA256 over `timestamp.url.body` with a 5-minute replay window.** Stronger than a bare shared-secret header, and lets the unit tests cover "replay".
- **D16. Twilio replay protection is idempotency, not timestamps.** Twilio signatures carry no timestamp; a replayed request is valid but is a no-op on `(provider, CallSid)`.
- **D17. The dial result is authoritative over the status callback.** If the parent `completed` status arrives first (caller hung up while ringing), the call is marked `abandoned` with `metadata.outcomeSource = 'status'`; a later `/voice/result` may overwrite it, a second result may not. Status callbacks only move forward (`metadata.statusRank`).
- **D18. `answered_at` = `max(started_at, now − talk)` and `ring_seconds` = `ended − started − talk`** at dial-result time. Twilio's `<Dial>` action reports duration, not timestamps.
- **D19. Twilio toll-free prefix search uses `Contains=833**\*\***\*`.** `AreaCode`applies to local numbers; results are re-filtered locally for`prefix`and`contains`.
- **D20. Inventory search over-fetches (100) and hides numbers already active on Relay**, so a busy mock inventory or a stale carrier cache never shows unbuyable numbers.
- **D21. Purchase reserves first.** A `provisioning` row claims the e164 via the partial unique index before the carrier call; on carrier failure the row is marked `released` and the API returns 409/502.
- **D22. Audit rows are written synchronously in the request transaction**; the worker writes only `call.finalised`. Failed logins are logged (structured, no PII), not audited: there is no organisation to attach them to.
- **D23. Every tenant query filters by `org_id` explicitly, and malformed ids return 404.** Integration tests prove another organisation gets 404 on read, change and release, and sees nothing in lists, filters, the dashboard or audit log.
- **D24. Roles:** owner/admin can change things; member is read-only for numbers and org; `buyer`/`agent` exist in the schema only and are denied every route.
- **D25. CSRF applies to login and register too** (double-submit `relay_csrf` cookie + `x-csrf-token` header), preventing login CSRF. `GET /api/v1/auth/csrf` issues the token.
- **D26. Extra rate limits:** forgot-password 5/h/IP and reset-password 10/h/IP, alongside login 5/min and register 3/h. Limits are stored in Redis so they hold across API instances.
- **D27. Live updates by polling** (call tables every 3 s, dashboard every 5 s, in-progress call detail every 2 s) instead of SSE. Meets the 5-second requirement with no extra infrastructure.
- **D28. Fonts are self-hosted via `@fontsource-variable/archivo`** so `next build` works without network access to Google Fonts.
- **D29. Landing page carries Terms and Conditions and Privacy Policy sections on the page itself, with no postal or email address**, per the owner's standing preference for every page built for them.
- **D30. Load smoke uses `autocannon` (npm) rather than k6**, so it runs with `pnpm load:smoke` and no extra binary. Each request has a unique `CallSid` (the real insert path); test rows are deleted afterwards.
- **D31. E2E runs the API and web on ports 4010/3010** against the compose (or CI) Postgres/Redis, and releases its number at the end so the mock inventory is reusable across runs. In CI it serves the production build (`E2E_USE_BUILD=1`).
- **D32. The finalise job is covered by API integration tests** (it lives in `@relay/db` as `finaliseCall`), so the worker package has no separate test suite in Phase 1.
- **D33. The worker retries `finalise-call` when the call is still `in_progress`** (status arrived out of order), using BullMQ exponential backoff, 5 attempts.
- **D34. MinIO comes from `cgr.dev/chainguard/minio`.** The `minio/minio` Docker Hub repository is no longer pullable; MinIO is reserved for Phase 3 recordings and unused in Phase 1.
- **D35. E2E production mode builds the web app itself** into `.next-e2e` with `API_URL` pointing at the E2E API, because Next.js resolves rewrites at build time. `next-env.d.ts` is generated (`next typegen` runs before `tsc`), not committed.

## Phase 2: routing engine

Built on the `phase-2-routing-engine` branch. IDs continue from Phase 1.

### Routing semantics

- **D36. Caps count calls sent to a target, reserved before dialling.** Concurrency, hourly, daily and total caps are checked and incremented in one Redis Lua script before the `<Dial>` goes out, so two calls can never take the last slot. A no-answer still counts toward hourly/daily/total (the target was offered the call); concurrency is freed when the leg ends.
- **D37. Hourly and daily caps reset on the target's schedule timezone, else the organisation's.** A daily cap for a Los Angeles desk resets at Los Angeles midnight, not UTC midnight.
- **D38. Within a tier, sequential mode picks by `weight × free capacity`** (`weight × (cap − live) / cap`, roadmap §5.1). With idle targets the split follows the weights (property-tested within ±3 points); near their caps, busier targets get proportionally fewer calls. The roadmap's answer-rate factor is deferred (= 1).
- **D39. "Tier order respected" means every attempt rings the lowest tier that has a target able to take the call.** A later failover attempt may go back to a lower tier if a slot there freed up meanwhile; the recorded explanation proves no skipped tier had an eligible target.
- **D40. Failover on no-answer, busy and failed; never on caller hang-up.** A target is never rung twice on one call: the tried set is every target with a leg on the call, read from Postgres inside the call's row lock. When every target was tried, the caller hears the campaign's unavailable message and the call ends with the last attempt's outcome.
- **D41. Simultaneous mode rings every eligible target in the lowest available tier in one `<Dial>`.** The winner is the leg the carrier names in `DialCallSid` (matched to per-leg callbacks), else the leg reported answered, else the only leg. The others are recorded as no answer.
- **D42. Slot lifecycle:** reserved for ring timeout + 60 s; extended to 4 h when the leg's `answered` callback arrives; released on the leg's completion callback, the dial result, or the parent call ending. Releases happen after the transaction commits. Anything missed is repaired by the reaper (30 s) and reconciliation (60 s) jobs.
- **D43. Reconciliation can only make caps stricter.** It re-adds open legs missing from Redis, removes holders whose leg is closed, and raises counters that are behind Postgres; it never lowers a counter, and never removes a holder whose leg row may still be in flight.
- **D44. Redis outage: reservations fall back to Postgres.** `DbReserver` locks the target rows `FOR UPDATE` and counts legs, inside the same transaction that writes the legs, so caps hold (tested). The route cache reads Postgres; the caller rate limit fails open (a Redis outage must not drop legitimate calls). Each fallback is recorded as a routing event.
- **D45. "Not configured" vs "unavailable".** A campaign with no usable target (none enabled, or all weight 0) plays "This number is not configured"; one whose targets are all busy, capped or closed plays the campaign's unavailable message (default provided) and logs `no_eligible_target`.
- **D46. Retries replay, they never re-route.** Each handler runs under the call row lock and stores the instruction it returned (`metadata.lastResponse`); a retried inbound, IVR or dial-result webhook gets the same TwiML rebuilt from the stored attempt. `call_attempts` and a unique `(call_id, attempt, target_id)` on legs make duplicates impossible.

### Schedules

- **D47. Schedule rules** (`packages/core/src/routing/schedule.ts`): a closed date closes the whole day including yesterday's spill-over; open dates replace weekly hours (all day when no times); otherwise weekly hours apply; a schedule with no weekly hours is open every day except closed dates; a close time at or before the open time crosses midnight; equal times mean 24 hours. Evaluated on the wall clock with `Intl`, so DST is handled by construction (tested across the spring-forward gap).

### Protection and IVR

- **D48. Blocklist is organisation-wide, exact E.164, answered with `<Reject reason="busy"/>`** so a blocked caller is never answered or billed.
- **D49. STIR/SHAKEN policies map Twilio's `StirVerstat`.** `block_failed` blocks failed verifications; `require_a_or_b` and `require_a` also block calls with no attestation.
- **D50. Per-caller limits are per campaign, sliding minute/hour windows keyed by CallSid** (idempotent under retries). Blocked attempts count, so a caller hammering the line stays blocked until the window clears.
- **D51. Press-a-digit gives one try.** Random digits are 1–9 (0 avoided as "operator"). No input or a wrong key ends the call as `screened_out` with `ivr_no_input` / `ivr_wrong_digit`. Prompts use `{digit}`; a prompt without it gets "Press N to continue." appended.

### Product surface

- **D52. Archiving a campaign detaches its numbers** (they stop forwarding until attached elsewhere) and makes it read-only except for restore. Targets are soft-deleted so past calls keep their target.
- **D53. The Phase 1 quick forwarding form still works for "simple" campaigns** (one number, at most one target). Otherwise `PATCH /numbers/:id` returns 409 `campaign_managed` and the number page links to the campaign.
- **D54. Live calls poll every 3 s** (the roadmap allows SSE or polling); timers tick locally against the server clock.
- **D55. Routing debug is owner/admin only:** `GET /calls/:id/routing` returns the decisions recorded at call time (protection verdict, IVR, every tier walked with each target's verdict and live counters); `POST /campaigns/:id/explain` is a read-only dry run for any time, with each target's pick probability.
- **D56. Per-leg callbacks use the `<Number statusCallback>` URL with `attempt` and `target` in the query string.** The carrier signs the full URL, so the query cannot be forged; the leg's parent call comes from `ParentCallSid`.
- **D57. The load test is a custom open-loop generator** (`pnpm load:smoke`) instead of autocannon: each call is a multi-step webhook flow with hold times, so caps bind and failover happens under load. Results: `docs/load-test-phase2.md`.
- **D58. Phase 2 is delivered on a branch** (`phase-2-routing-engine`) for review rather than pushed to `main`. (Merged as PR #1.)

## Hosting on Vercel

The owner chose Vercel as the only host. Vercel runs functions, not long-lived processes, so the
always-on API and the BullMQ worker are adapted rather than moved. The standalone layout
(apps/api + apps/worker) still works unchanged.

- **D59. The API runs inside the Next.js app, one Vercel project.** Route handlers for `/api/v1/*`, `/voice/*`, `/healthz`, `/readyz` and `/api/cron/*` hand each request to the same Fastify app via `inject` (`apps/api/src/embedded.ts`), built once per instance and reused. One domain means first-party cookies, no cross-project rewrite (which would lose the caller's IP for rate limits) and one URL for Twilio. Locally and in the standalone layout the same handlers proxy to `API_URL`, which replaces the old Next.js rewrite.
- **D60. "Warm Fastify" on Vercel means Fluid compute instance reuse, not a dedicated process.** The first request to a new instance pays a 1–2 s boot; Twilio waits 15 s, so no call is lost, but those requests miss the 300 ms target. Measured locally, one instance holds p95 54 ms at 75 calls/s and saturates above that (Next.js adds about 1.3 ms of CPU per request on top of the API's own work); Vercel scales out with more instances. 100 calls/s on one 2-vCPU box does not pass in this layout; the standalone layout does (p95 42 ms).
- **D61. Jobs run inline on Vercel** (`JOBS_MODE=inline`, the default when `VERCEL` is set). Call finalisation is deferred with `waitUntil` after the webhook response. A crash or timeout in between is repaired by a sweep for ended calls with no `billed_seconds` (new partial index, migration 0004).
- **D62. Routing maintenance rides on traffic.** After any response, an instance that has not tried in the last 30 s sets a Redis lock (`maint:run`, 30 s, NX); the holder runs the reaper, and reconciliation plus the finalise sweep when `maint:reconcile` (60 s, NX) is also free. The lock serialises them across instances as the worker's single-concurrency queue did. A daily Vercel Cron (`/api/cron/maintenance`, Bearer `CRON_SECRET`, 404 without a secret) is the backstop; Hobby allows only daily crons, and reservations expire on their own regardless.
- **D63. Serverless data stores.** Neon's pooled `DATABASE_URL` (PgBouncer, transaction mode) gets unprepared statements, detected from the URL; migrations use `DATABASE_URL_UNPOOLED` because they take an advisory lock. Nothing else uses session state. Pools are 5 connections per instance on Vercel. `KV_URL` is accepted as the Redis URL. Migrations run on production builds only (`apps/web/scripts/vercel-build.mjs`), so preview deploys cannot change the production schema unless `RUN_MIGRATIONS=true`.
- **D64. URLs default to the project's production domain on Vercel** (`VERCEL_PROJECT_PRODUCTION_URL`), so a fresh deploy needs no URL settings. `PUBLIC_API_URL` must be set before numbers are bought when a custom domain is used, because Twilio signs the URL it calls.
- **D65. Demo mode:** `ALLOW_MOCK_PROVIDER=true` permits the mock carrier in production, but only with a `MOCK_WEBHOOK_SECRET` of 24+ characters that is not the development default. It lets the owner deploy and click through before Twilio is set up.

## Deferred

- Deferred: **Team invites, email verification and TOTP MFA** (roadmap §7.2). Phase 1 has single-owner organisations plus seeded/test members.
- Deferred: **Organisation delete (owner-only)** endpoint and UI.
- Deferred: **Telnyx adapter** implementation (see D1) and **multi-provider failover** (Phase 5).
- Deferred: **Local numbers + E911** (see D2), **toll-free verification (TFV)**, **KYC/KYB** before purchase.
- Deferred: **Recordings, wallet, Stripe, metering, number monthly fees, buy/sell prices** (Phase 3). Money columns and helpers exist; prices are stored as 0.
- Deferred: **SSRF DNS resolution.** `assertSafeWebhookUrl` checks syntax and IP literals; Phase 4 must also resolve hostnames and re-check at connect time.
- Deferred: **Negative route caching.** Unknown numbers hit Postgres each time; fine at Phase 1 volume.
- Deferred: **Content-Security-Policy for the web app**, OpenTelemetry tracing, Sentry, `pnpm audit` and OWASP ZAP in CI (roadmap §7.2, Phase 6).
- Deferred: **SSE live-calls view** (see D27, D54).
- Deferred: **Answer-rate weighting** (roadmap's EWMA "AI routing", Phase 5); the factor is 1 today (D38).
- Deferred: **Hold queue, overflow number and voicemail** when every target is busy (roadmap §5.1 step 10); callers hear the unavailable message instead.
- Deferred: **Duplicate/repeat-caller policy** and **block VoIP / international callers** (roadmap §5.1); the `is_repeat` columns exist.
- Deferred: **Redis Cluster.** The reservation script touches keys of several targets, so a cluster deployment needs hash tags per campaign. Single-node or sentinel Redis is assumed.
- Deferred: **Per-leg SIP codes** from carrier callbacks (`call_legs.sip_code` stays null).
- Deferred: **SIP and browser-agent targets** (Phase 5); the schema allows them, the router skips them as `unsupported_type`.
