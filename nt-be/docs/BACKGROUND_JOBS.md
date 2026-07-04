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

## Web UI

Set `JOBS_UI_ADDR` (e.g. `127.0.0.1:3003`) to serve the board + its REST
API (`/api/v1`). **The board has no authentication** — bind it to
localhost / a private network, never the public interface. Unset = disabled.

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
