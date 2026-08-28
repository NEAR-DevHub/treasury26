# Alerting Runbooks

How error events flow: code emits `tracing::error!` (backend) or `Sentry.captureException` (frontend) with two tags — `error_code` (stable, one Sentry issue per code) and `alert_priority` (`p0`/`p1`/`p2`). **All Telegram routing happens in Sentry alert rules via the Telegram connector** — the application sends no alert-Telegram itself (the few legacy direct sends — sponsor low balance, sweeper give-up, status-monitor incidents — predate this system and remain).

Environments: rules below apply to `environment:production` only. Staging events stay in Sentry.

## Alert rules (configure once in Sentry UI)

| # | Condition | Action | Rationale |
|---|---|---|---|
| 1 | `alert_priority:p0` — any event | Telegram, immediately | funds-affecting; needs a human now |
| 2 | `alert_priority:p1` — any event | Telegram, immediately | user-blocking; loosen to once-per-hour-per-issue if noisy after tuning |
| 3 | `error_code:PROPOSAL_EXECUTION_FAILED` ≥ 3 events / 1 h | Telegram | single failures are usually user-caused (insufficient DAO balance = Info) |
| 4 | `error_code:BULK_PAYOUT_FAILED` ≥ 5 events / 30 min | Telegram | one failed attempt retries in 5 s; a stream means the batch is stuck |
| 5 | everything else | Sentry only | untagged errors and job failures are triaged from the Sentry inbox |

## Error-code runbooks

### p0

| Code | Meaning | Response |
|---|---|---|
| `CONF_INTENT_SUBMIT_FAILED` | Vote approved on-chain but 1Click rejected the signed intent; row now `failed`, **nothing retries it** | Check `confidential_intents` row (`submit_result` has the 1Click error). If transient: re-submit manually (same signed payload — 1Click dedupes by payload hash). If 1Click is down: check `near-intents` incident in the status system; re-submit after recovery. |
| `CONF_INTENT_SIG_PARSE_FAILED` | MPC signature present in vote outcome but unparseable — signer format drift; intent stuck `pending` | This broke silently once before (2026-07 borsh change). Diff the vote outcome's signature blob against `extract_mpc_signature` expectations (`relay/confidential.rs`); code fix required, then re-drive the intent. |
| `CONF_INTENT_MARK_FAILED_LOST` | Submit failed AND the `failed`-status write was lost; row looks `pending` forever | Manually set the row's status/`submit_result`, then treat as `CONF_INTENT_SUBMIT_FAILED`. |
| `FLEET_STALLED` | Liveness monitor: most job queues stale or DB unreachable; process self-restarts | Usually recovers on restart. If it repeats: check Postgres health/connection count, then Render service events. |
| `DB_UNAVAILABLE` (via `/api/health` 503 + Oh Dear) | App database down | Render database dashboard; check connection exhaustion (`DATABASE_MAX_CONNECTIONS`). |
| `GOLDSKY_SINK_CONNECT_FAILED` | Goldsky sink DB unreachable at boot — app starts anyway with the enrichment worker disabled, and the `goldsky.database` status probe reports Skipped (pool is `None`), so nothing else will page | Check the sink DB / `GOLDSKY_DATABASE_URL`, then redeploy/restart to reconnect. Until then ingestion enrichment is silently off. |

### p1

| Code | Meaning | Response |
|---|---|---|
| `RELAY_SUBMIT_FAILED` | Sponsor-signed submission 5xx — proposal creation/votes blocked | Check sponsor account balance (low-balance alert may have fired) and NEAR RPC incident status. Every affected user action failed visibly. |
| `EXCHANGE_TERMINAL_FAILED` / `PAYMENT_TERMINAL_FAILED` | A 1Click exchange / cross-chain payment ended FAILED / REFUNDED / INCOMPLETE_DEPOSIT | Look up the proposal (`dao`/`proposal_id` in event context). REFUNDED: funds returned, inform user if they ask. INCOMPLETE_DEPOSIT: sent amount below quote — usually user error, but a pattern means a quoting bug. |
| `VERIFICATION_GATE_FAILED` | DAO's ledger failed on-chain verification — its chart is unavailable/stale | Per-DAO. Check drift values in the event; known causes catalogued 2026-08 (system-refund phantom inflows, sponsor deposit under-booking, dust tolerance). Gate retries after 6 h cool-off or on ledger rebuild. |
| `TREASURY_CREATE_GAVE_UP` | Creation sweeper exhausted retries; user's treasury half-created | `incomplete_treasury_creations` row has the last error. Fix cause, reset the row to `pending` to re-drive, or contact the user. |
| `CONFIG_INVALID_CORS_ORIGIN` | An allowed origin failed to parse at boot — that frontend origin is blocked | Fix `CORS_ALLOWED_ORIGINS` and redeploy. |
| `FE_WALLET_SIGN_FAILED` | Wallet returned a non-rejection error during signing (e.g. the Meteor parse-error class) | Check wallet-type tag for a pattern; usually a wallet-side regression after a protocol change. |
| `JOB_STALE` (p2, but systemic patterns matter) | One queue not progressing | Board (`/` behind admin auth) → queue → last error. One stale queue is p2; many at once escalates to `FLEET_STALLED`. |

### p2 (Sentry inbox, no page)

`PROPOSAL_EXECUTION_FAILED`, `BULK_PAYOUT_FAILED`, `BULK_PAYOUT_STATE_WRITE_FAILED`, `DEPOSIT_ADDRESS_FAILED`, `RELAY_SPEND_RECORD_FAILED`, `VERIFICATION_HEAD_DRIFT`, `ALERT_TELEGRAM_SEND_FAILED`, `FE_API_FAILED`, `FE_QUERY_FAILED`, `FE_MUTATION_FAILED`, `FE_WALLET_AUTH_FAILED` — review during triage; frequency rules 3–4 above page on the two that can stall money.

`ALERT_TELEGRAM_SEND_FAILED` is deliberately Sentry-only: every legacy direct send accompanies an incident that already pages through its own coded event, so a failed send must not page the same incident twice. During triage, check bot token validity and chat ids — Sentry routing is unaffected (this event arriving proves it).

## Staging failure-injection drill

Run on staging after alert rules are configured; each step must produce exactly the listed alert and nothing else.

1. **1Click outage**: point `CONFIDENTIAL_API_URL` at an unroutable host, approve a test confidential transfer → `CONF_INTENT_SUBMIT_FAILED` (p0 → Telegram) within the request timeout (30 s).
2. **Relay outage**: set an invalid `SIGNER_KEY`, create a proposal → `RELAY_SUBMIT_FAILED` (p1 → Telegram), user sees the error toast.
3. **Failed exchange**: seed a quote proposal with a deposit address 1Click reports as `INCOMPLETE_DEPOSIT` → `EXCHANGE_TERMINAL_FAILED` (p1 → Telegram) on the next `public-quote-status-refresh` tick (≤2 min).
4. **Verification failure**: corrupt one test DAO's ledger head balance → `VERIFICATION_GATE_FAILED` (p1 → Telegram) on next projection.
5. **Fleet stall**: pause the staging Postgres for >15 min → `JOB_STALE` events, then `FLEET_STALLED` (p0) and process self-restart.
6. **Scrub check**: `tracing::error!` a fake JWT on a test endpoint → the Sentry event must show `[REDACTED]`.
7. **Grouping check**: trigger step 3 for two different DAOs → both events land in **one** Sentry issue (`EXCHANGE_TERMINAL_FAILED`), DAOs distinguishable via tags.

## Noise tuning (first two weeks)

Weekly: Sentry → Issues → group by `error_code`, sort by volume. Any code paging without a resulting action gets a threshold or a demotion to p2 (edit the emitting site's `tags.alert_priority`). Any Info-class event found in Telegram is a bug — fix the emitting site, not the rule.
