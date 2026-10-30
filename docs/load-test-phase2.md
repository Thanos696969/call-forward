# Phase 2 load test: routing engine at 100 calls/s

Command: `pnpm load:smoke --rate 100 --duration 30` against the production build of the API
(`node apps/api/dist/server.js`, `LOG_LEVEL=warn`, mock carrier), Postgres 16 and Redis 7 in Docker,
load generator on the same 2-vCPU machine.

## Traffic

Open-loop: 100 new calls per second for 30 s, regardless of how fast earlier calls finish. Every call
walks the real voice path with signed webhooks: `/voice/inbound` → hold 0–3 s (ringing and talking,
slot held) → `/voice/result` with a random outcome (60% answered, 20% no answer, 15% busy, 5% failed) →
on a miss the router fails over and the next result follows. About 150 calls are live at any moment,
so concurrency caps bind and calls spill across tiers.

Campaign: 5 targets in 3 tiers, sequential mode.

| Target | Tier | Weight | Concurrency cap | Other caps     |
| ------ | ---- | ------ | --------------- | -------------- |
| A      | 1    | 70     | 20              |                |
| B      | 1    | 30     | 20              |                |
| C      | 2    | 50     | 40              |                |
| D      | 2    | 50     | 40              |                |
| E      | 3    | 100    | 100             | 2,000 per hour |

## Results

2,999 calls, 4,188 dial attempts, 7,187 webhooks, **0 failed requests**.
Outcomes: 2,519 answered, 226 no answer, 183 busy, 63 failed, 8 found every target busy.

| Endpoint                         | Requests |    p50 |     p95 |      p99 |      max |
| -------------------------------- | -------: | -----: | ------: | -------: | -------: |
| `/voice/inbound`                 |    2,999 | 8.3 ms | 43.4 ms | 124.9 ms | 242.9 ms |
| `/voice/result` (incl. failover) |    4,188 | 9.1 ms | 40.9 ms |  84.8 ms | 194.5 ms |
| All webhooks                     |    7,187 | 8.8 ms | 41.8 ms | 106.0 ms | 242.9 ms |

Target: p95 < 300 ms. **Met with about 7× headroom.**

### Caps under load

Live legs per target were sampled from Redis every 50 ms for the whole run.

| Target | Cap | Highest live count seen | Calls sent |
| ------ | --: | ----------------------: | ---------: |
| A      |  20 |                      20 |        457 |
| B      |  20 |                      20 |        449 |
| C      |  40 |                      40 |        798 |
| D      |  40 |                      40 |        828 |
| E      | 100 |                     100 |      1,656 |

Every cap was reached and **none was exceeded**. No target was rung twice on the same call.
Because tier 1 sat at its caps most of the run, A and B received similar volumes despite their
70/30 weights: the pick is weighted by free capacity (DECISIONS D38). The pure weight split is
verified separately (10,000 calls within ±3 points, `packages/routing/test`).

## Notes

- p99 is dominated by the generator and API sharing two vCPUs with Postgres and Redis.
- Each inbound call is one Postgres transaction (call row, protection check, attempt, legs, routing
  event) plus one Redis script; each dial result is one transaction plus one script for failover.
- Reproduce: `pnpm --filter @relay/api build`, start the API with `TELEPHONY_PROVIDER=mock`, then
  `pnpm load:smoke --api http://localhost:4000`. Add `--json report.json` for machine-readable output.

## Vercel layout (API embedded in Next.js)

The same test against `next start` with the API embedded, inline jobs and no worker (the code
path Vercel runs), on the same 2-vCPU machine. Postgres pool 5 per instance (the Vercel default)
unless noted.

| Offered load         | Webhooks |   p50   |   p95    |   p99    | Failures | Cap violations | Double rings |
| -------------------- | -------: | :-----: | :------: | :------: | -------: | -------------: | -----------: |
| 50 calls/s           |    3,981 | 10.0 ms | 27.0 ms  | 54.1 ms  |        0 |              0 |            0 |
| 75 calls/s           |    5,609 | 15.2 ms | 53.7 ms  | 125.4 ms |        0 |              0 |            0 |
| 100 calls/s          |    6,161 | 708 ms  | 1,102 ms | 1,162 ms |        0 |              0 |            0 |
| 100 calls/s, pool 20 |    6,599 | 177 ms  |  814 ms  |  919 ms  |        0 |              0 |            0 |

- One Next.js process saturates between 75 and 100 calls/s here: Next.js adds about 1.3 ms of CPU
  per request (a static page tops out near 800 requests/s), and at 100 calls/s the single Node
  thread shares 2 vCPUs with Postgres, Redis and the generator. Running two instances on the
  same 2 vCPUs did not help (p95 481 ms) because there was no spare CPU to give them.
- On Vercel each instance has its own CPU and the platform adds instances under load, so the
  per-instance figure (p95 54 ms at 75 calls/s) is the one that carries over; verify on the
  deployment with the command in `docs/DEPLOY-VERCEL.md`.
- Correctness held at every rate, including when webhooks for one call were spread
  round-robin across two instances: every cap reached and never exceeded, no double rings.
- Reproduce: `E2E`-style build with `EMBED_API=true JOBS_MODE=inline` (or `VERCEL=1`), then
  `pnpm load:smoke --api http://localhost:3000[,http://localhost:3001]`.
