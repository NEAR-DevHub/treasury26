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

Every worker is wrapped in three layers of failure containment
(`spawn_cron_worker!` in `src/jobs/mod.rs`), so a job keeps running through
transient faults instead of dying until the next process restart:

1. **Task errors** — a failing task is retried up to `TASK_RETRIES` (2)
   times; after that the failure is recorded and the next cron tick starts
   a fresh task. One bad cycle never stops the schedule.
2. **Handler panics** — `catch_panic` turns a panic into a task error
   (same path as #1) instead of tearing the worker down.
3. **Worker-loop exit** — on a sustained backend/storage failure the
   supervisor rebuilds and restarts the worker with capped exponential
   backoff (1s → 60s), forever; the backoff resets after a run that stayed
   up `RESTART_HEALTHY_AFTER` (5 min). A worker never dies silently.

Handlers that do several steps run **all** steps and aggregate failures
rather than aborting on the first error (e.g. notifications detect +
dispatch, monthly credit reset + export expiry, FT-lockup refresh +
claims); the goldsky drain reports partial progress on a mid-drain failure
(its cursor is persisted per batch). Startup migrations for apalis are
tracked in a private `apalis_migrations` schema so they never collide with
the app's own `_sqlx_migrations`.

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
| price-sync | every 60s | — | |
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
