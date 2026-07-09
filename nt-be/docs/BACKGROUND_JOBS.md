# Background jobs (apalis)

All recurring backend workers are organized with [apalis](https://github.com/apalis-dev/apalis)
(1.0.0-rc): each job is an apalis worker fed by an `apalis-cron` schedule
piped into a per-job Postgres queue (`apalis.jobs` in the app database).
See `src/jobs/` — `mod.rs` (registration/schedules) and `handlers.rs`
(one thin handler per job wrapping the existing per-cycle function).

What this replaces: 17 hand-rolled `tokio::spawn` + interval loops in
`main.rs`. What it adds, uniformly:

- task history, results, and errors persisted per queue
- a web UI (apalis-board) to inspect queues/workers and trigger any job
  manually (PUT a task into its queue)
- per-task tracing spans; `concurrency(1)` guarantees cycles never overlap
- failed cycles are visible as failed tasks instead of just log lines

## Resilience

All workers run under a single apalis `Monitor` (`spawn_all` in
`src/jobs/mod.rs`) — the framework's own multi-worker supervisor, rather
than a hand-rolled `tokio::spawn` loop per worker. It gives three layers of
failure containment plus coordinated shutdown:

1. **Task errors** — the failure is recorded and the next cron tick starts
   a fresh task. One bad cycle never stops the schedule. There is
   deliberately **no automatic task-level retry**: several handlers have
   non-idempotent side effects (on-chain `payout_batch` / `claim` txs,
   Telegram sends), so re-running the whole handler on any error could
   duplicate them. The cron schedule *is* the retry, and apalis-postgres
   retries transient DB/poll errors at the backend with its own backoff.
2. **Handler panics** — `catch_panic` turns a panic into a task error
   (same path as #1) instead of tearing the worker down.
3. **Worker exit** — if a worker's run loop exits on a sustained
   backend/storage failure, the `Monitor`'s `should_restart` hook rebuilds
   and restarts it (the factory gets a fresh connection); a clean exit on
   shutdown is honoured, so in-flight tasks drain instead of being fought by
   a restart. The whole set runs on one supervised task and stops together
   on **`SIGINT` or `SIGTERM`** (`run_with_signal`) — SIGTERM being what
   containers/systemd send for a graceful stop.

Restarts are immediate (apalis's `Monitor`'s `should_restart` hook is
synchronous, so it can't back off). This doesn't hot-loop: transient DB
outages are absorbed by apalis-postgres's own fetcher backoff (1s→5min)
*inside* `worker.run()`, so a worker rarely exits on a blip; it only exits
on a terminal condition, which is rare. If a cooldown on repeated exits is
later wanted, apalis's native `circuit_breaker` worker ext (with a
`recovery_timeout`) is the tool.

Handlers that do several steps run **all** steps and aggregate failures
rather than aborting on the first error (e.g. notifications detect +
dispatch, monthly credit reset + export expiry, FT-lockup refresh +
claims); the goldsky drain reports partial progress on a mid-drain failure
(its cursor is persisted per batch). Startup migrations for apalis are
tracked in a private `apalis_migrations` schema so they never collide with
the app's own `_sqlx_migrations`.

## Error reporting (Sentry)

Each worker carries apalis's own `SentryLayer` (feature `sentry`, sharing
the same `sentry-core` as the app's `sentry` crate, so it uses the global
hub initialised in `observability.rs`). Per task it:

- opens a Sentry performance transaction (APM), and
- on failure, `capture_error`s the actual error with the `queue`, task id,
  and attempt as Sentry context — better grouping and filtering than a
  formatted log line.

It's layered *outside* `catch_panic`, so a failure is reported **once**,
including panics (which `catch_panic` turns into errors). To avoid
double-reporting, the per-task tracing layer logs failures at `WARN`
instead of the default `ERROR` (a failed cycle is retried by the next cron
tick, so it's a warning); that keeps the generic `tracing → Sentry` bridge
from emitting a second event for the same failure. `SentryLayer` is a no-op when
`SENTRY_DSN` is unset. Worker-level errors (a worker exiting / being
restarted by the monitor) are still logged at `ERROR` and reach Sentry via
that bridge.

## Web UI

The apalis-board (UI + its REST API at `/api/v1`) is served on the main
HTTP service — same listener/port as the rest of the API, like the
warnings admin pages — as the router's `fallback_service`. Every board
route is behind **HTTP Basic Auth** using the same `ADMIN_USERS`
credentials as the warnings admin pages; with `ADMIN_USERS` unset the
board returns `401` for all requests. Unknown public `/api/*` paths keep
returning a plain `404` (the board only owns `/api/v1`).

## Queues

| Queue | Schedule (default) | Env override | Notes |
|---|---|---|---|
| account-maintenance | every 60s | MAINTENANCE_INTERVAL_SECONDS | gated by DISABLE_BALANCE_MONITORING |
| confidential-poll | every 300s | CONFIDENTIAL_POLL_INTERVAL_SECONDS | gated by DISABLE_BALANCE_MONITORING |
| price-sync | every 60s | — | syncs DeFiLlama prices into `historical_prices` |
| token-price-ingest | every 60s | — | refreshes `tokens` and 5-minute `token_prices` from Chaindefuser |
| public-history-scheduler | every 2s | — | enqueues public latest/backfill page jobs; latest enqueue skipped without GOLDSKY_DATABASE_URL |
| public-silver-projection | every 5s | — | gated by NEARBLOCKS_API_KEY |
| public-gold-projection | every 5s | — | gated by NEARBLOCKS_API_KEY |
| public-proposal-reconciliation | every 10min | — | gated by NEARBLOCKS_API_KEY |
| confidential-history-ingest | every 10s | — | |
| confidential-snapshots | hourly | — | |
| confidential-gold-reconciliation | daily + startup task | — | |
| bulk-payment-payout | every 5s | — | |
| goldsky-enrichment | every 15s | ENRICHMENT_INTERVAL_SECONDS | skipped without GOLDSKY_DATABASE_URL; drains full batches within one task |
| treasury-creation-sweeper | every 15s + Notify-triggered tasks | DISABLE_TREASURY_CREATION_SWEEPER | failed creations push a task instantly |
| status-monitor | every 60s | — | |
| notifications | every 15s | — | detection + Telegram dispatch joined per task |
| sponsor-balance-monitor | every 60s | SPONSOR_BALANCE_POLL_INTERVAL_SECONDS | |
| dao-list-sync | every 30min | — | |
| dao-policy-dirty | every 5s | — | was a 1s poll; 5s avoids a task row per second |
| dao-policy-stale | every 60s | — | |
| subscription-monthly-reset | daily 00:00 UTC + startup task | — | |
| public-dashboard-refresh | Mondays 00:00 UTC + startup task | — | gated by DISABLE_STATS_GENERATION; skips when this week's snapshot exists |
| ft-lockup-refresh | every 6h + startup task | — | gated by DISABLE_FT_LOCKUP_SCHEDULER |
| apalis-prune | daily 03:30 UTC | APALIS_TASK_RETENTION_DAYS (7) | deletes finished tasks so 5s queues don't grow unbounded |

## Behavior changes vs the old loops

- Intervals are now cron-aligned (e.g. "every 60s" fires on minute
  boundaries) instead of relative to process start; "initial delay" env
  vars are gone — the first cron tick is at most one interval after boot,
  and startup-run jobs get an explicit boot task instead.
- `dao-policy-dirty` runs every 5s instead of every 1s.
- A single apalis migration set (`PostgresStorage::setup`) creates the
  `apalis` schema in the app database at boot (idempotent).
- Multiple backend replicas would each run their own cron ticks; the
  Postgres queue dedupes execution per task, but tick production assumes
  a single instance (same as the old loops).
