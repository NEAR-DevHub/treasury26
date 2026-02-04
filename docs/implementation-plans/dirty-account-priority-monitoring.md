# Dirty Account Priority Monitoring Plan

Issue: https://github.com/NEAR-DevHub/treasury26/issues/135

## Summary

When users interact with a treasury through the UI, the backend should immediately prioritize that account's balance history sync. This is achieved by marking accounts as "dirty" with a timestamp that defines how far back to fill gaps. Dirty accounts get dedicated parallel tasks **in addition to** the normal monitoring cycle, giving them double attention.

## Motivation

The current monitoring cycle (`run_monitor_cycle`) processes all enabled accounts sequentially, ordered by staleness. When a user opens their treasury in the UI, they may have to wait for the next monitoring cycle to pick up their account — and if other accounts are ahead in the queue, the wait grows. Users expect to see recent transaction history immediately after interacting with the treasury.

## Design

### Core concept: `dirty_at` timestamp

A single nullable timestamp field on `monitored_accounts` serves two purposes:

1. **Dirty flag** — `dirty_at IS NOT NULL` means the account needs priority attention
2. **Backfill boundary** — the timestamp value defines how far back in time to fill gaps (e.g., `NOW() - 24h` means fill the last 24 hours)

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        main.rs                                │
├──────────────────────────┬───────────────────────────────────┤
│   Existing Monitor Loop  │   NEW: Dirty Account Watcher      │
│   (unchanged)            │                                    │
│                          │   Polls for dirty_at IS NOT NULL   │
│   - Sequential           │   Spawns parallel tokio tasks      │
│   - All tokens + staking │   per dirty account                │
│   - 30s interval         │                                    │
│                          │   ┌─────────┐  ┌─────────┐       │
│                          │   │ Account │  │ Account │  ...   │
│                          │   │ Task A  │  │ Task B  │       │
│                          │   └─────────┘  └─────────┘       │
│                          │                                    │
│                          │   - Gap fill only (no staking)     │
│                          │   - Most recent gaps first         │
│                          │   - Clears dirty_at when done      │
└──────────────────────────┴───────────────────────────────────┘
```

### What the dirty task does per account

1. Get all tokens for the account
2. For each token (skipping staking tokens), find gaps between `dirty_at` and now
3. Fill gaps in **reverse block height order** (most recent first)
4. After all gaps in the `dirty_at → now` window are filled, set `dirty_at = NULL`

### What the dirty task does NOT do

- Staking reward tracking (main cycle only)
- Token discovery (main cycle only)
- Historical gap filling before `dirty_at` (main cycle only)

## Implementation Phases

### Phase 1: Schema + API

**Migration:** Add `dirty_at` column

```sql
ALTER TABLE monitored_accounts
ADD COLUMN dirty_at TIMESTAMPTZ;
```

**Endpoint:** `POST /api/monitored-accounts/{account_id}/dirty`

- Sets `dirty_at = NOW() - INTERVAL '24 hours'` (default)
- Optionally accepts a `since` body param to control backfill depth
- Returns the updated account record
- If account doesn't exist or isn't enabled, returns 404

**Files to modify:**
- `nt-be/migrations/YYYYMMDD_add_dirty_at.sql` — new migration
- `nt-be/src/routes/monitored_accounts.rs` — new endpoint + update `MonitoredAccount` struct
- `nt-be/src/routes/mod.rs` — register new route

### Phase 2: Dirty account watcher

**New module:** `nt-be/src/handlers/balance_changes/dirty_monitor.rs`

Core function:

```rust
pub async fn run_dirty_monitor(
    pool: &PgPool,
    network: &NetworkConfig,
    hint_service: Option<&TransferHintService>,
) {
    // 1. Query: SELECT * FROM monitored_accounts WHERE dirty_at IS NOT NULL AND enabled = true
    // 2. For each dirty account, spawn a tokio task
    // 3. Each task:
    //    a. Get current block height
    //    b. Get all non-staking tokens for account
    //    c. For each token, find gaps where gap.end_block >= dirty_at_block
    //    d. Fill gaps in reverse order (highest end_block first)
    //    e. After all gaps filled, SET dirty_at = NULL
}
```

**Files to modify:**
- `nt-be/src/handlers/balance_changes/dirty_monitor.rs` — new module
- `nt-be/src/handlers/balance_changes/mod.rs` — register module

### Phase 3: Wire into main.rs

Spawn the dirty watcher as a new background task alongside the existing ones:

```rust
// Spawn dirty account priority monitoring
{
    let state_clone = state.clone();
    tokio::spawn(async move {
        // Poll every 5 seconds for dirty accounts
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            run_dirty_monitor(
                &state_clone.db_pool,
                &state_clone.archival_network,
                state_clone.transfer_hint_service.as_ref(),
            ).await;
        }
    });
}
```

**Files to modify:**
- `nt-be/src/main.rs` — spawn dirty watcher task

### Phase 4: Tests

Following TDD guidelines from the project:

1. **Unit test:** `dirty_monitor` fills gaps in reverse order and clears `dirty_at`
2. **Unit test:** `dirty_monitor` skips staking tokens
3. **Integration test:** POST `/dirty` endpoint sets `dirty_at`, dirty monitor processes it, `dirty_at` becomes NULL
4. **Unit test:** Concurrent safety — dirty task and main cycle don't create duplicate records (relies on existing `ON CONFLICT` clauses)

## Key Design Decisions

1. **Additive, not replacing** — The dirty watcher runs alongside the existing monitor cycle. Dirty accounts get attention from both. This avoids modifying the proven monitoring loop.

2. **`dirty_at` as backfill boundary** — Rather than a boolean flag + separate config for how far back to look, the timestamp itself defines the window. The API caller controls the depth.

3. **Most-recent-first gap filling** — Users care about recent transactions. By filling gaps in reverse block height order, the most recent activity appears in the UI first.

4. **No staking in dirty tasks** — Staking reward tracking is expensive (epoch snapshots, binary search per epoch). It stays in the main cycle to avoid overloading RPC during priority syncs.

5. **No rate limiting for now** — Dirty tasks make RPC calls without throttling. This can be added later if needed.

6. **Concurrent safety** — The existing `ON CONFLICT` clauses in balance_changes inserts handle the case where both the dirty task and main cycle try to fill the same gap simultaneously.

## File Structure

```
nt-be/
├── migrations/
│   └── YYYYMMDD_add_dirty_at_to_monitored_accounts.sql
├── src/
│   ├── main.rs                              # Add dirty watcher spawn
│   ├── routes/
│   │   ├── mod.rs                           # Register dirty route
│   │   └── monitored_accounts.rs            # Add dirty endpoint + update struct
│   └── handlers/balance_changes/
│       ├── mod.rs                           # Register dirty_monitor module
│       └── dirty_monitor.rs                 # NEW: dirty account watcher
```

## References

- Current monitoring cycle: `nt-be/src/handlers/balance_changes/account_monitor.rs`
- Gap detection: `nt-be/src/handlers/balance_changes/gap_detector.rs`
- Gap filling: `nt-be/src/handlers/balance_changes/gap_filler.rs`
- Monitored accounts API: `nt-be/src/routes/monitored_accounts.rs`
- Background task spawning: `nt-be/src/main.rs:28-91`
