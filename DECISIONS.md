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
- **D34. MinIO comes from `cgr.dev/chainguard/minio`.** The `minio/minio` Docker Hub repository is no longer pullable; MinIO is reserved for Phase 3 recordings and unused in Phase 1.
- **D33. The worker retries `finalise-call` when the call is still `in_progress`** (status arrived out of order), using BullMQ exponential backoff, 5 attempts.

## Deferred

- Deferred: **Team invites, email verification and TOTP MFA** (roadmap §7.2). Phase 1 has single-owner organisations plus seeded/test members.
- Deferred: **Organisation delete (owner-only)** endpoint and UI.
- Deferred: **Telnyx adapter** implementation (see D1) and **multi-provider failover** (Phase 5).
- Deferred: **Local numbers + E911** (see D2), **toll-free verification (TFV)**, **KYC/KYB** before purchase.
- Deferred: **Campaigns UI, weights, tiers, caps, schedules, failover, IVR, call protection** (Phase 2). The router already walks tiers (`selectTarget`).
- Deferred: **Recordings, wallet, Stripe, metering, number monthly fees, buy/sell prices** (Phase 3). Money columns and helpers exist; prices are stored as 0.
- Deferred: **SSRF DNS resolution.** `assertSafeWebhookUrl` checks syntax and IP literals; Phase 4 must also resolve hostnames and re-check at connect time.
- Deferred: **Twilio per-number status-callback events.** Twilio sends the number-level `StatusCallback` on completion only by default; Phase 2 should request `initiated ringing answered completed` on the `<Number>` for per-leg timing.
- Deferred: **Negative route caching.** Unknown numbers hit Postgres each time; fine at Phase 1 volume.
- Deferred: **Content-Security-Policy for the web app**, OpenTelemetry tracing, Sentry, `pnpm audit` and OWASP ZAP in CI (roadmap §7.2, Phase 6).
- Deferred: **SSE live-calls view** (see D27).
