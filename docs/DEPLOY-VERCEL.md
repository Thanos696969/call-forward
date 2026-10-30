# Deploying Relay on Vercel

Everything runs in **one Vercel project** built from this GitHub repo:

```
Caller ─▶ Twilio ─▶ https://<your-project>.vercel.app/voice/*  ┐
Browser ───────────▶ https://<your-project>.vercel.app/app/*    ├─ one Next.js app on Vercel
                     https://<your-project>.vercel.app/api/v1/* ┘  (the Fastify API runs inside it)
                                    │                 │
                          Neon Postgres        Upstash Redis
                        (Vercel Storage)     (Vercel Storage)
```

- The portal, the REST API and the Twilio voice webhooks share one domain. The API is the same
  Fastify code as the standalone server, run inside the Next.js route handlers
  (`apps/web/src/server/api-bridge.ts`).
- There is no worker process on Vercel. Call finalisation runs right after each webhook's
  response, and routing maintenance (reaper and reconciliation) runs on ordinary traffic at
  most every 30 s, plus a daily Vercel Cron as a safety net. See DECISIONS.md D59–D65.

## What you need

| Service                                | Plan                                    | Why                                                            |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Vercel                                 | Hobby to try it; **Pro for a business** | Hobby is for personal, non-commercial use under Vercel's terms |
| Neon Postgres (from Vercel Storage)    | Free tier is enough to start            | Database                                                       |
| Upstash Redis (from Vercel Storage)    | Free tier is enough to start            | Route cache, live call counters, caps, rate limits             |
| Twilio                                 | Pay as you go                           | Real numbers and calls (skip for a demo, see step 4)           |
| An SMTP provider (Resend, Postmark, …) | Optional                                | Password reset emails                                          |

Free tiers have limits: Upstash's free plan counts every Redis command (a call uses roughly
15–30), and Neon's free compute sleeps after a few idle minutes, adding about a second to the
first request after a pause. Upgrade either when real traffic arrives.

## Step by step

### 1. Import the repo

1. In Vercel: **Add New… → Project**, pick the GitHub repo **Thanos696969/call-forward**, **Import**.
2. **Root Directory**: click **Edit** and choose **`apps/web`**. This is the only setting that
   must change. Framework (Next.js), install and build commands come from `apps/web/vercel.json`.
3. Don't deploy yet if Vercel lets you skip; otherwise let the first deploy fail (it stops with
   "DATABASE_URL is not set") and continue.

### 2. Add Postgres and Redis

In the project: **Storage → Create Database** (or **Connect Store**):

1. **Neon** (Serverless Postgres). Region **US East (N. Virginia)**, to match the functions
   (`iad1`). Connect it to **all environments**. This adds `DATABASE_URL` and
   `DATABASE_URL_UNPOOLED`.
2. **Upstash for Redis**. Region **US East (N. Virginia)**, connect to all environments. This
   adds `REDIS_URL` / `KV_URL`.

Optional: in the Neon integration settings, turn on a **database branch per preview deployment**
and add `RUN_MIGRATIONS=true` for the **Preview** environment. Without that, preview deploys
skip migrations so a pull request can never change the production schema.

### 3. Environment variables

**Settings → Environment Variables**, environment **Production** (and Preview if you use previews):

| Name                                                                | Value                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TELEPHONY_PROVIDER`                                                | `twilio`                                                            |
| `TWILIO_ACCOUNT_SID`                                                | from the Twilio console (`AC…`)                                     |
| `TWILIO_AUTH_TOKEN`                                                 | from the Twilio console                                             |
| `CRON_SECRET`                                                       | a long random string (e.g. `openssl rand -hex 32`)                  |
| `PUBLIC_API_URL`                                                    | only with a custom domain: `https://calls.example.com` (see step 6) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | optional, for password reset emails                                 |

Everything else has a working default on Vercel: the public URL is the project's production
domain, jobs run inline, the database pool is sized for serverless.

### 4. (Alternative) demo without Twilio

To click through the portal before you have Twilio, use the mock carrier instead of step 3's
Twilio variables:

| Name                  | Value                                     |
| --------------------- | ----------------------------------------- |
| `TELEPHONY_PROVIDER`  | `mock`                                    |
| `ALLOW_MOCK_PROVIDER` | `true`                                    |
| `MOCK_WEBHOOK_SECRET` | a random string of at least 24 characters |

"Buying" a number then creates a fake one, and you simulate calls from your computer:

```bash
pnpm simulate-call --to <number> --api https://<project>.vercel.app \
  --public-url https://<project>.vercel.app --secret <MOCK_WEBHOOK_SECRET> --outcomes no-answer,completed
```

Remove these three variables and add Twilio's to go live.

### 5. Deploy and check

1. **Deployments → Redeploy** (or push to `main`). The production build applies the database
   migrations, then builds the app.
2. Open `https://<project>.vercel.app/readyz`. It should say
   `{"status":"ready","checks":{"db":"ok","redis":"ok"}}`.
3. Open `https://<project>.vercel.app`, create your account, buy a number. With Twilio,
   buying sets the number's Voice URL to `https://<project>.vercel.app/voice/inbound`
   automatically. Call it.

### 6. Custom domain (optional)

Add the domain under **Settings → Domains**, then set `PUBLIC_API_URL` (and `WEB_URL`) to
`https://<your-domain>` and redeploy.

Twilio signs each webhook with the exact URL it called, so do this **before buying numbers**.
Numbers bought earlier keep calling the old `vercel.app` URL. That still works as long as
`PUBLIC_API_URL` is unchanged. If you do change it, update each existing number's Voice URL in
the Twilio console to `https://<your-domain>/voice/inbound` and its status callback to
`https://<your-domain>/voice/status`.

## How it behaves on Vercel

- **Region**: functions run in `iad1` (US East), next to Twilio's US edge, Neon and Upstash.
  Keep all three in the same region; cross-region round trips add latency to every webhook.
- **Cold starts**: the first request to a new instance boots the API (about 1–2 s). Twilio
  waits up to 15 s for a webhook response, so calls are not dropped, but those first requests
  are slower than the 300 ms target. Vercel's Fluid compute keeps instances warm and reuses
  them across requests, so this is rare under steady traffic.
- **Capacity**: one instance handled 75 calls/s within target in local tests (p95 54 ms).
  Vercel adds instances as traffic grows. See `docs/load-test-phase2.md`.
- **Maintenance**: the reaper and reconciliation run at most every 30 s while there is
  traffic. With no traffic nothing needs repairing: every reservation also expires on its own.
  The daily cron (`/api/cron/maintenance`, protected by `CRON_SECRET`) finalises anything left
  over. On Vercel Pro you can change the schedule in `apps/web/vercel.json` to every minute
  (`* * * * *`).
- **Deployment Protection**: Vercel protects preview URLs by default. Twilio only calls the
  production URL, so leave production unprotected.
- **Logs**: the project's **Logs** tab shows the API's JSON log lines (request ids, masked phone
  numbers).

## Load-testing the deployment

From your computer, against a demo deployment (step 4) and its Neon database:

```bash
DATABASE_URL='<Neon DATABASE_URL_UNPOOLED>' REDIS_URL='<Upstash REDIS_URL>' \
PUBLIC_API_URL=https://<project>.vercel.app MOCK_WEBHOOK_SECRET=<secret> \
pnpm load:smoke --api https://<project>.vercel.app --rate 100 --duration 30
```

It creates its own test organisation and removes it afterwards. Expect higher latency than the
local numbers by the round trip from your computer to `iad1`.

## Running without Vercel

Nothing about the standalone layout changed: `apps/api` (Fastify on its own port) plus
`apps/worker` (BullMQ) behind any process manager, with the web app's `API_URL` pointing at the
API. That layout keeps the API permanently warm and is the better fit above a few hundred calls
per second.
