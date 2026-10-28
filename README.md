# Relay — call forwarding portal (Phase 1)

A customer signs up, buys a US toll-free number, points it at one destination phone, and every
inbound call rings that phone and lands in a call log with caller, number, destination, duration
and outcome.

This repository is Phase 1 ("walking skeleton") of the plan in the roadmap: auth, numbers,
one-destination forwarding, call logs and a dashboard. The data model is already shaped for the
later routing platform (campaigns → weighted targets), but only the Phase 1 surface is exposed.
See [DECISIONS.md](DECISIONS.md) for every assumption and deferred item.

## Quick start

Requirements: Node 22.12+, pnpm 10, Docker.

```bash
docker compose up -d          # Postgres 16, Redis 7, MinIO, Mailpit
pnpm install
pnpm db:migrate
pnpm db:seed                  # demo@relay.local / relay-demo-password, number +1 800 555 0100
pnpm dev                      # web :3000, API :4000, worker
```

No `.env` is needed locally: every setting defaults to the docker-compose services and the mock
carrier. Copy `.env.example` to `.env` to change anything.

- Web app: http://localhost:3000
- API docs (OpenAPI, dev only): http://localhost:4000/docs
- Emails (password reset): http://localhost:8025

### Demo script (no carrier account needed)

1. Open http://localhost:3000 and create an account.
2. **Buy number** → pick a prefix → click a number. You land on its page.
3. Enter a destination such as `+14155550123`, keep **Forward calls** on, **Save forwarding**.
4. Simulate a carrier call to the number you bought:

   ```bash
   pnpm simulate-call --to +18005550101 --from +13125550187
   # other outcomes: --outcome no-answer | busy | failed | canceled   --duration 73
   ```

5. Within a few seconds the call appears on the number page, in **Call log** and on the
   **Dashboard**. Click it for the attempt timeline.

The simulator sends HMAC-signed `/voice/inbound`, `/voice/result` and `/voice/status` webhooks
exactly as the mock carrier would.

## Architecture

```
            PSTN                         ┌──────────────── apps/api (Fastify, always warm) ───────────────┐
 Caller ───────────▶ Carrier ──webhook──▶│ /voice/inbound  verify signature → route cache → 1 SQL → TwiML │
                     (Twilio /           │ /voice/result   outcome + talk time, enqueue finalise          │
                      mock)  ◀──TwiML────│ /voice/status   monotonic status, never regresses              │
                       │                 │ /api/v1/*       REST for the portal (session + CSRF + RBAC)    │
                       ▼                 └───────┬─────────────────────────┬───────────────────────────────┘
                 Destination phone               │                         │
                                          Redis (route:{e164} 60 s,   Postgres 16
                                          rate limits, BullMQ,        (source of truth)
                                          reset tokens)                    ▲
                                                 │                         │
 Browser ─▶ apps/web (Next.js 15) ─/api/v1 rewrite─▶ API         apps/worker (BullMQ): finalise-call
```

- **Voice path** (`apps/api/src/routes/voice.ts`, `services/voice.ts`): a Fastify route, never a
  Next.js or serverless function. Signature check, compiled route from Redis (Postgres fallback if
  Redis is down), one round-trip upsert of the call and its first leg, TwiML out. Every handler is
  idempotent on `(provider, CallSid)`.
- **Routing** (`packages/core/src/routing/route.ts`): Phase 1 dials the first enabled phone target,
  but walks priority tiers so Phase 2's weighted, capacity-aware pick slots in.
- **Control plane**: `/api/v1` REST with `{ data, meta }` / `{ error }` envelopes, cursor pagination,
  Zod validation (unknown fields rejected), OpenAPI generated from the schemas.
- **Data plane**: the worker's `finalise-call` job sets `billed_seconds` (Phase 1 placeholder =
  talk seconds) and writes an audit row.

| Package         | What it holds                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web`      | Next.js 15 App Router portal + landing page, Tailwind, shadcn-style components, TanStack Query, Recharts |
| `apps/api`      | Fastify 5 API and carrier webhooks, sessions, CSRF, rate limits, OpenAPI                                 |
| `apps/worker`   | BullMQ consumers (Phase 1: call finalisation)                                                            |
| `packages/core` | Shared schemas and DTOs, E.164, money (integer micros), outcomes, routing, telephony providers           |
| `packages/db`   | SQL migrations, Drizzle schema, seed, migration runner, `finaliseCall`                                   |
| `packages/ui`   | UI primitives shared by the web app                                                                      |

### Security notes

- Passwords: Argon2id (64 MiB, t=3, p=1). Sessions: 32 random bytes in an httpOnly, SameSite=Lax
  cookie (Secure in production); only the SHA-256 is stored; 30-day sliding expiry; rotated on login.
- CSRF: double-submit token on every state-changing `/api/v1` request.
- Rate limits (Redis-backed, per IP): login 5/min, register 3/h, forgot-password 5/h.
- RBAC on the server for every route; members are read-only. Every tenant query filters by `org_id`.
- Helmet, strict CORS, 256 KB body limit, structured logs with request ids; cookies, tokens and
  signatures are redacted and phone numbers are masked in logs.

## Environment variables

Every variable is documented in [.env.example](.env.example). The ones you are most likely to set:

| Variable                                  | Default                                       | Purpose                                                     |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`                            | `postgres://relay:relay@localhost:5432/relay` | Postgres                                                    |
| `REDIS_URL`                               | `redis://localhost:6379`                      | Redis (route cache, queue, rate limits)                     |
| `TELEPHONY_PROVIDER`                      | `mock` (or `twilio` when Twilio keys are set) | `mock`, `twilio` or `telnyx`                                |
| `PUBLIC_API_URL`                          | `http://localhost:4000`                       | Public base URL the carrier calls; must be HTTPS for Twilio |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | —                                             | Twilio credentials                                          |
| `MOCK_WEBHOOK_SECRET`                     | `dev-mock-webhook-secret` (dev only)          | Signs simulated webhooks                                    |
| `WEB_ORIGIN`, `WEB_URL`                   | `http://localhost:3000`                       | CORS origin and links in emails                             |
| `API_URL`                                 | `http://localhost:4000`                       | Where the web app proxies `/api/v1`                         |
| `SMTP_*`, `MAIL_FROM`                     | Mailpit on `localhost:1025`                   | Password reset emails                                       |

In production the API refuses to start with the mock carrier or without Secure cookies.

## Using real Twilio calls

1. Expose the API publicly, e.g. `ngrok http 4000`, and note the HTTPS URL.
2. In `.env`:
   ```bash
   TELEPHONY_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   PUBLIC_API_URL=https://<your-tunnel>.ngrok.app
   ```
3. Restart `pnpm dev`, buy a number in the UI (this purchases it on your Twilio account and sets its
   Voice URL to `${PUBLIC_API_URL}/voice/inbound` and status callback to `/voice/status`), set the
   destination, and call it from any phone.

Signatures are verified against `PUBLIC_API_URL` + the request path, so it must match the URL
Twilio calls exactly. Toll-free numbers need Twilio toll-free verification before they reach
full answer rates.

## Swapping providers

All carrier specifics live behind `TelephonyProvider` (`packages/core/src/telephony/provider.ts`):
search, purchase, release, configure, webhook verification and response building. Each number
stores its `provider` and `provider_ref`, so numbers from different carriers can coexist.

To add or finish a carrier, implement the interface (see the mapping notes in
`telnyx.ts`), add it to `createProvider` in `factory.ts`, and set `TELEPHONY_PROVIDER`. The voice
routes, schema and UI do not change. Telnyx TeXML uses the same webhook fields and response XML as
Twilio, so the shared `parseVoiceParams` and TwiML builders apply.

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test          # unit (core, api) + API integration tests on Testcontainers (needs Docker)
pnpm e2e           # Playwright: signup → buy → forward → simulated call → log + dashboard
pnpm build
pnpm load:smoke    # with `pnpm dev` running: /voice/inbound at 100 req/s, fails if p95 ≥ 300 ms
```

- Integration tests start their own Postgres 16 and Redis 7 containers.
- E2E needs `docker compose up -d` (it runs the API and web on ports 4010/3010 against the local
  database) and `pnpm --filter @relay/web exec playwright install chromium` once.

## Scripts

| Command                                              | What it does                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                                           | Web, API and worker with reload                                              |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply migrations / add demo data / drop everything and start over (dev only) |
| `pnpm simulate-call --to <e164>`                     | Signed mock carrier call (`--outcome`, `--duration`, `--from`)               |
| `pnpm load:smoke`                                    | Voice hot-path load test                                                     |
| `pnpm format`                                        | Prettier                                                                     |
