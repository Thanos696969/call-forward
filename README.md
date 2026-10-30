# Relay — call forwarding portal (Phases 1–2)

A customer signs up, buys US toll-free numbers and routes every inbound call through a campaign:
weighted, capacity-capped, scheduled targets in priority tiers, with failover, a press-a-digit
screen and call protection. Every call lands in a call log with a per-attempt leg timeline.

- **Phase 1** ("walking skeleton"): auth, numbers, one-destination forwarding, call logs, dashboard.
- **Phase 2** (this branch): the routing engine — campaigns, targets, schedules, sequential and
  simultaneous ringing with failover, Redis routing state, IVR, call protection, live calls and
  an admin routing debugger.

See [ROADMAP.md](ROADMAP.md) for the plan and [DECISIONS.md](DECISIONS.md) for every assumption
(D1–D58) and deferred item.

## Deploy on Vercel

The whole app deploys as **one Vercel project**: import this repo, set **Root Directory** to
`apps/web`, add **Neon** (Postgres) and **Upstash** (Redis) from Vercel Storage, set the Twilio
keys and a `CRON_SECRET`, deploy. The API runs inside the Next.js app and there is no worker to
host. Full walkthrough, demo mode without Twilio, custom domains and limits:
**[docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md)**.

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

A number with one target stays in this simple forwarding view. For the routing engine:

1. **Campaigns → New campaign**, then **Add target** a few times with different tiers, weights and
   caps (for example tier 1 "Front desk" weight 70 cap 2, tier 1 "Overflow" weight 30, tier 2
   "On-call"). **Schedule** sets daily or dated windows in the target's timezone.
2. **Numbers** tab → attach the number. **Press-a-digit** and **Call protection** tabs configure
   the IVR, caller ID policy and per-caller limits; **Settings → Blocked callers** holds the blocklist.
3. **Test routing** (owners and admins) explains, target by target, who would ring now.
4. Simulate calls that fail over:

   ```bash
   pnpm simulate-call --to +18005550101 --outcomes no-answer,busy,completed
   pnpm simulate-call --to +18005550101 --hold        # stays connected: watch it on Live calls
   pnpm simulate-call --to +18005550101 --digit 5 --stir TN-Validation-Passed-A
   ```

5. **Live calls** refreshes every 3 s; the call detail page shows each attempt, the phones it rang
   and, for owners and admins, the router's recorded reasoning.

The simulator follows the router like a carrier would: HMAC-signed `/voice/inbound`, `/voice/ivr`,
`/voice/result`, per-leg `/voice/leg` and `/voice/status` webhooks.

## Architecture

```
            PSTN                         ┌──────────────── apps/api (Fastify, always warm) ───────────────┐
 Caller ───────────▶ Carrier ──webhook──▶│ /voice/inbound  signature → protection → IVR or plan attempt   │
                     (Twilio /           │ /voice/ivr      digit check → plan attempt                     │
                      mock)  ◀──TwiML────│ /voice/result   outcome → failover to next attempt or finish   │
                       │                 │ /voice/leg      per-leg answer / end, extends reservation      │
                       ▼                 │ /voice/status   monotonic status, releases reservations        │
                 Target phones           │ /api/v1/*       REST for the portal (session + CSRF + RBAC)    │
                                         └───────┬─────────────────────────┬───────────────────────────────┘
                                                 │                         │
                                          Redis: route cache, live    Postgres 16
                                          legs, cap counters, caller  (source of truth)
                                          limits, BullMQ               ▲
                                                 │                     │
 Browser ─▶ apps/web (Next.js 15) ─/api/v1 rewrite─▶ API     apps/worker (BullMQ): finalise-call,
                                                             routing reaper 30 s, reconcile 60 s
```

- **Voice path** (`apps/api/src/routes/voice.ts`, `services/voice.ts`): a Fastify route, never a
  Next.js or serverless function. Each handler verifies the signature, locks the call row in one
  transaction, stores the TwiML it returned and replays it on carrier retries, so every webhook is
  idempotent. The set of targets already rung comes from the call's legs, so no target rings twice.
- **Planner** (`packages/core/src/routing/`, pure and isomorphic): walks tiers in order; drops
  targets that are disabled, zero-weight, already tried or outside schedule; asks the reserver for
  capacity; picks by effective weight `weight × (cap − live) / cap` (sequential) or rings every
  eligible target in the tier (simultaneous). Every verdict is recorded for the debugger.
- **Routing state** (`packages/routing`): a compiled route per number cached at `route:{e164}` for
  60 s and invalidated on every campaign edit; one Lua script atomically prunes expired holders,
  checks the concurrent, hourly, daily and total caps and reserves; Postgres row locks are the
  fallback when Redis is down. See [Routing state](#routing-state).
- **Two layouts, same code**: standalone (the API on its own port plus the BullMQ worker; the
  web app proxies API paths to `API_URL`) or Vercel (the API runs inside the Next.js route
  handlers, jobs run inline and maintenance rides on traffic; see
  [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md)).
- **Control plane**: `/api/v1` REST with `{ data, meta }` / `{ error }` envelopes, cursor pagination,
  Zod validation (unknown fields rejected), OpenAPI generated from the schemas.
- **Data plane**: the worker's `finalise-call` job sets `billed_seconds` (Phase 1 placeholder =
  talk seconds) and writes an audit row.

| Package            | What it holds                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `apps/web`         | Next.js 15 App Router portal + landing page, Tailwind, shadcn-style components, TanStack Query, Recharts |
| `apps/api`         | Fastify 5 API and carrier webhooks, sessions, CSRF, rate limits, OpenAPI                                 |
| `apps/worker`      | BullMQ consumers: call finalisation, routing reaper and reconciliation                                   |
| `packages/core`    | Shared schemas and DTOs, E.164, money (integer micros), outcomes, routing planner, telephony providers   |
| `packages/routing` | Server-only routing state: route cache, Redis and Postgres reservers, caller limits, maintenance jobs    |
| `packages/db`      | SQL migrations, Drizzle schema, seed, migration runner, `finaliseCall`                                   |
| `packages/ui`      | UI primitives shared by the web app                                                                      |

### Security notes

- Passwords: Argon2id (64 MiB, t=3, p=1). Sessions: 32 random bytes in an httpOnly, SameSite=Lax
  cookie (Secure in production); only the SHA-256 is stored; 30-day sliding expiry; rotated on login.
- CSRF: double-submit token on every state-changing `/api/v1` request.
- Rate limits (Redis-backed, per IP): login 5/min, register 3/h, forgot-password 5/h.
- RBAC on the server for every route; members are read-only; the routing debugger
  (`POST /campaigns/:id/explain`, `GET /calls/:id/routing`) is owners and admins only.
  Every tenant query filters by `org_id`.
- Helmet, strict CORS, 256 KB body limit, structured logs with request ids; cookies, tokens and
  signatures are redacted and phone numbers are masked in logs.

## Routing state

| Key                             | Type   | Meaning                                                              |
| ------------------------------- | ------ | -------------------------------------------------------------------- |
| `route:{e164}`                  | string | Compiled route (campaign, tiers, targets, schedules), 60 s TTL       |
| `ccz:{targetId}`                | ZSET   | Live legs, member `callSid:attempt`, score = reservation expiry (ms) |
| `cap:h:{targetId}:{YYYYMMDDHH}` | string | Calls this hour in the target's timezone, 2 h TTL                    |
| `cap:d:{targetId}:{YYYYMMDD}`   | string | Calls today in the target's timezone, 3 d TTL                        |
| `cap:t:{targetId}`              | string | Calls ever                                                           |
| `rl:call:{campaignId}:{from}`   | ZSET   | Per-caller sliding window for call protection                        |

- A reservation lives for ring timeout + 60 s and is extended to 4 h when the leg answers, so a
  lost callback can never hold capacity for long. It is released when the leg or call ends.
- **Reaper** (worker, every 30 s): drops expired holders and releases holders whose call already
  ended in Postgres.
- **Reconcile** (worker, every 60 s): rebuilds live sets from open legs and raises hourly, daily and
  total counters to at least what Postgres recorded. It never lowers a counter, so a cap is never
  loosened by a race.

## API (Phase 2 additions)

| Endpoint                                                                            | Who                 |
| ----------------------------------------------------------------------------------- | ------------------- |
| `GET/POST /campaigns`, `GET/PATCH /campaigns/:id` (pause, archive, IVR, protection) | read / owner, admin |
| `POST /campaigns/:id/numbers`, `DELETE /campaigns/:id/numbers/:numberId`            | owner, admin        |
| `POST/PATCH/DELETE /campaigns/:id/targets[/:targetId]`                              | owner, admin        |
| `PUT/DELETE /campaigns/:id/targets/:targetId/schedule`                              | owner, admin        |
| `POST /campaigns/:id/explain` — why each target is or is not eligible               | owner, admin        |
| `GET/POST /blocklist`, `DELETE /blocklist/:id`                                      | read / owner, admin |
| `GET /calls/live`, `GET /calls/:id` (attempts and legs)                             | every role          |
| `GET /calls/:id/routing` — recorded routing decisions                               | owner, admin        |

Full schemas are in the OpenAPI docs at `/docs`.

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
| `API_URL`                                 | `http://localhost:4000`                       | Where the web app proxies API paths; unset on Vercel        |
| `SMTP_*`, `MAIL_FROM`                     | Mailpit on `localhost:1025`                   | Password reset emails                                       |

In production the API refuses to start with the mock carrier (unless `ALLOW_MOCK_PROVIDER=true`
with a strong secret, for demos) or without Secure cookies. Vercel-specific variables
(`CRON_SECRET`, `JOBS_MODE`, `DB_POOL_MAX`, `RUN_MIGRATIONS`) are described in `.env.example`.

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
pnpm test          # unit + property tests (core), routing and API integration tests (Testcontainers)
pnpm e2e           # Playwright: forwarding journey, campaign failover, live calls, call detail
E2E_EMBEDDED=1 pnpm e2e   # the same tests in the Vercel layout (API inside Next.js, no worker)
pnpm build
pnpm load:smoke    # with the API running: 100 calls/s through the full routing path
```

- Property tests (fast-check, `packages/core/test` and `packages/routing/test`) prove: no cap is
  ever exceeded, no target rings twice on a call, tiers are tried in order, and weighted picks land
  within ±3 % of the configured weights.
- `pnpm load:smoke [--rate 100] [--duration 30] [--json out.json]` creates its own organisation and
  3-tier campaign, holds calls so the caps bind, samples every live-leg set, reports p50/p95/p99 per
  webhook and fails on any error, cap breach, double ring or p95 ≥ 300 ms. Results:
  [docs/load-test-phase2.md](docs/load-test-phase2.md).
- Integration tests start their own Postgres 16 and Redis 7 containers.
- E2E needs `docker compose up -d` (it runs the API and web on ports 4010/3010 against the local
  database) and `pnpm --filter @relay/web exec playwright install chromium` once.

## Scripts

| Command                                              | What it does                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm dev`                                           | Web, API and worker with reload                                                                |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply migrations / add demo data / drop everything and start over (dev only)                   |
| `pnpm simulate-call --to <e164>`                     | Signed mock carrier call (`--outcomes`, `--digit`, `--stir`, `--hold`, `--duration`, `--from`) |
| `pnpm load:smoke`                                    | Routing engine load test at 100 calls/s                                                        |
| `pnpm format`                                        | Prettier                                                                                       |
