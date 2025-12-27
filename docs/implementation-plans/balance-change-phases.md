# Balance Change Collection - Implementation Phases

This document breaks down the implementation into small, reviewable phases. Each phase builds on the previous one and can be tested independently.

## Test-Driven Development Approach

**Every phase follows TDD:**
1. Write integration test first (can fail initially)
2. Write unit tests for the component
3. Implement the minimum code to pass tests
4. Refactor while keeping tests green

Integration tests are written early and updated as new functionality is added. They serve as living documentation and ensure components work together correctly.

---

## Phase 1: Integration Test Infrastructure ✅ COMPLETED

**Goal:** Set up integration test framework and first test case.

**New file:** `tests/balance_collection_integration_test.rs`

**Initial test:**
```rust
#[sqlx::test]
async fn test_detect_gaps_in_balance_chain(pool: PgPool) -> sqlx::Result<()> {
    // Insert records with gaps
    // Call gap detection (will fail initially)
    // Assert gaps are correctly identified
    Ok(())
}
```

**Review criteria:**
- Test database setup works
- Can run with `cargo test --test balance_collection_integration_test`
- Clear test structure and assertions
- Uses sqlx test fixtures

---

## Phase 2: Database Schema ✅ COMPLETED

**Goal:** Create balance_changes table with proper schema.

**Files:**
- `migrations/20251223000001_create_balance_changes.sql`

**Schema includes:**
- `raw_data JSONB` - for storing raw blockchain data for debugging
- `actions JSONB` - for storing transaction actions
- Proper indexes for efficient queries

**Review criteria:**
- Migration runs successfully
- Integration test passes

---

## Phase 3: Core Data Structures ✅ COMPLETED

**Goal:** Define Rust types for balance changes and gaps.

**Implemented in:** `src/handlers/balance_changes/gap_detector.rs`

**Define:**
```rust
pub struct BalanceGap {
    pub account_id: String,
    pub token_id: String,
    pub start_block: i64,
    pub end_block: i64,
    pub expected_balance_before: String,
    pub actual_balance_after: String,
}
```

**Review criteria:**
- Types are well-documented
- Clear separation of concerns
- Integration test demonstrates usage

---

## Phase 4: Gap Detection Algorithm ✅ COMPLETED

**Goal:** Implement logic to scan existing records and find gaps.

**Implemented in:** `src/handlers/balance_changes/gap_detector.rs`

**TDD approach:**
1. Write integration test with known gap scenarios
2. Write unit tests for edge cases (no records, single record, no gaps)
3. Implement gap detection
4. All tests pass

**Function:**
```rust
pub async fn find_gaps(
    pool: &PgPool,
    account_id: &str,
    token_id: &str,
    start_block: i64,
) -> Result<Vec<BalanceGap>>
```

**Implementation approach - SQL Window Functions:**

Use PostgreSQL's LAG window function to compare `balance_after` of each record with `balance_before` of the next:

```sql
WITH balance_chain AS (
    SELECT 
        account_id,
        token_id,
        block_height,
        balance_before,
        balance_after,
        LAG(block_height) OVER w as prev_block_height,
        LAG(balance_after) OVER w as prev_balance_after
    FROM balance_changes
    WHERE account_id = $1 
      AND token_id = $2
      AND block_height <= $3
    WINDOW w AS (PARTITION BY account_id, token_id ORDER BY block_height)
)
SELECT 
    account_id,
    token_id,
    prev_block_height as start_block,
    block_height as end_block,
    prev_balance_after::TEXT as actual_balance_after,
    balance_before::TEXT as expected_balance_before
FROM balance_chain
WHERE prev_block_height IS NOT NULL 
  AND balance_before != prev_balance_after;
```

**Benefits:**
- Single efficient query with O(n) complexity
- Database handles sorting and comparison
- No need to load all data into memory
- Leverages PostgreSQL's optimized window functions

**Integration test scenarios:**
- No existing records → no gaps
- Connected chain → no gaps  
- Gap in middle → detected
- Multiple gaps → all detected
- Gap at start (no previous record) → handled correctly

**Review criteria:**
- Clear, readable function logic
- Well-commented SQL queries
- All tests pass
- Handles edge cases (no previous record means starting point, not a gap)

---

## Phase 5: Balance Query Service ✅ COMPLETED

**Goal:** Query balance at specific block heights via RPC.

**Implemented in:** `src/handlers/balance_changes/balance/mod.rs` (with submodules: `near.rs`, `ft.rs`, `intents.rs`)

**TDD approach:**
1. Write integration test querying real mainnet account
2. Write unit tests with mocked RPC responses
3. Implement balance queries
4. Tests pass

**Functions:**
```rust
pub async fn get_balance_at_block(
    account_id: &str,
    token_id: &str,
    block_height: i64,
) -> Result<String>
```

**Supports:**
- NEAR native token
- Fungible tokens (NEP-141)
- NEAR Intents multi-tokens (format: `intents.near:nep141:token.near`)

**Integration test:**
```rust
#[tokio::test]
async fn test_query_mainnet_balance() {
    let balance = get_balance_at_block(
        "webassemblymusic-treasury.sputnik-dao.near",
        "NEAR",
        150000000, // Block from test data range
    ).await.unwrap();
    assert!(!balance.is_empty());
}
```

**Review criteria:**
- Handles NEAR native vs FT vs Intents tokens
- Integration test validates against mainnet with real test data
- Uses limited block range from existing test data (139109383-176950919)
- Unit tests cover error cases
- Function length < 50 lines each

---

## Phase 6: Block Timestamp Service ✅ COMPLETED

**Goal:** Retrieve block timestamps from RPC.

**Implemented in:** `src/handlers/balance_changes/block_info.rs`

**TDD approach:**
1. Write integration test querying known mainnet block from test data
2. Implement with caching
3. Test validates timestamp matches expected

**Function:**
```rust
pub async fn get_block_timestamp(
    block_height: i64,
) -> Result<i64>
```

**Review criteria:**
- Integration test passes with real block
- Caches results to avoid redundant calls (moka cache)
- Clear error handling

---

## Phase 7: Binary Search for Changes ✅ COMPLETED

**Goal:** Implement RPC-based binary search to find exact block of change.

**Implemented in:** `src/handlers/balance_changes/binary_search.rs`

**TDD approach:**
1. Write integration test with known balance change block on mainnet (from test data)
2. Write unit tests with mocked balance queries
3. Implement binary search
4. Tests find exact block

**Function:**
```rust
pub async fn find_balance_change_block(
    account_id: &str,
    token_id: &str,
    start_block: i64,
    end_block: i64,
    expected_balance: &str,
) -> Result<Option<i64>>
```

**Unit test scenarios:**
- Balance changed in middle → finds block
- No balance change → returns None
- Change at boundaries → handles correctly
- Single block range → returns correctly

**Integration test:**
- Query known mainnet transaction from test data
- Binary search finds the block
- Validates it's the correct block

**Tested tokens:**
- NEAR native (block 151386339)
- Intents BTC `intents.near:nep141:btc.omft.near` (block 159487770)
- FT arizcredits.near (block 168568482, balance: 3 ARIZ)

**Review criteria:**
- Clear binary search logic
- All tests pass
- Function broken into helpers if > 50 lines

---

## Phase 8: Gap Filler Service (RPC-based) ✅ COMPLETED

**Goal:** Main service that fills gaps using RPC-based binary search. This is the core functionality that enables balance change collection without external APIs.

**Implemented in:** `src/handlers/balance_changes/gap_filler.rs`

**TDD approach:**
1. Update integration test to fill actual gaps end-to-end
2. Implement orchestration using existing RPC components
3. Test validates gaps are filled correctly

**Key implementation note:** Binary search must search up to `end_block - 1` because RPC returns balance at the END of a block, while `expected_balance_before` at block N equals balance at the END of block (N-1).

**Function:**
```rust
pub async fn fill_gap(
    pool: &PgPool,
    network: &NetworkConfig,
    gap: &BalanceGap,
) -> Result<BalanceChange>

pub async fn fill_gaps(
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    token_id: &str,
    start_block: i64,
) -> Result<usize> // returns number of gaps filled
```

**Logic for `fill_gap`:**
1. Use binary search to find exact block where balance changed
2. Query balance before and after at that block
3. Get block timestamp
4. Insert new `BalanceChange` record into database
5. Return the inserted record

**Logic for `fill_gaps`:**
1. Call gap detector to find all gaps
2. For each gap, call `fill_gap`
3. Return count of gaps filled

**Integration test:**
```rust
#[sqlx::test]
async fn test_fill_gaps_end_to_end(pool: PgPool) -> sqlx::Result<()> {
    // Insert records with known gaps (from test data)
    // Call fill_gaps
    // Verify gaps are filled
    // Verify balance chain is continuous
    // Run gap detection again - should find no gaps
    Ok(())
}
```

**Note:** This phase uses only RPC queries (binary search + balance queries). Third-party APIs (Nearblocks, Pikespeak) will be added in later phases to speed up the process by providing transaction hints, but are not required for basic functionality.

**Review criteria:**
- Orchestrates existing RPC components clearly
- Integration test demonstrates full workflow
- Inserts valid records into database
- Error handling with context
- Functions < 60 lines

---

## Phase 9: Counterparty Extraction ✅ COMPLETED

**Goal:** Extract counterparty from transaction receipts.

**Implementation:** Integrated into `gap_filler.rs` and `block_info.rs`

**Approach taken:**
- Query chunk data via near-jsonrpc-client to get receipts for each block
- Extract receipt metadata: receipt_id, predecessor_id, receiver_id
- Store predecessor_id as both signer_id and counterparty in database
- Store full ReceiptView (from near-primitives) in raw_data JSON field
- Database columns: receipt_id (TEXT[]), signer_id, receiver_id, counterparty

**Key functions:**
```rust
// In block_info.rs
pub async fn get_block_data(
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
) -> Result<BlockReceiptData>

// BlockReceiptData contains Vec<ReceiptView> from near-primitives
```

**Integration tests:**
- `test_get_block_receipt_data`: Validates receipt extraction from block 176927244
- `test_fill_gaps_with_bootstrap`: Verifies receipt columns populated during gap filling
- All receipts stored with full JSON in raw_data for future analysis

**Review criteria:**
- ✅ Extracts counterparty from receipts (predecessor_id)
- ✅ Uses official near-primitives::views::ReceiptView types
- ✅ Tests validate real blockchain data
- ✅ Full receipt data preserved in raw_data JSON

---

## Phase 10: Monitored Accounts Table ✅ COMPLETED

**Goal:** Create database table for accounts to monitor continuously.

**Implementation:** `migrations/20251227000001_create_monitored_accounts.sql`

**Table schema:**
```sql
CREATE TABLE monitored_accounts (
    account_id TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_synced_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_monitored_accounts_enabled ON monitored_accounts(enabled) WHERE enabled = true;
```

**Features:**
- Primary key on account_id for uniqueness
- `enabled` flag to control which accounts are actively monitored
- `last_synced_at` tracks when each account was last processed
- Automatic `updated_at` timestamp via database trigger
- Partial index on enabled accounts for efficient queries

**Integration test:** `test_monitored_accounts`
- ✅ Insert monitored accounts (enabled and disabled)
- ✅ Query only enabled accounts
- ✅ Update last_synced_at after processing
- ✅ Verify updated_at trigger works
- ✅ All assertions pass

**Review criteria:**
- ✅ Migration runs successfully
- ✅ Can insert and query accounts
- ✅ Index improves query performance
- ✅ Clear model struct (implicit via sqlx queries)

---

## Phase 11: Continuous Monitoring Service ✅ COMPLETED

**Goal:** Implement continuous monitoring loop that processes enabled accounts.

**Implemented in:** `src/handlers/balance_changes/account_monitor.rs`, `src/main.rs`

**Implementation:**
- Created `run_monitor_cycle()` function that processes all enabled accounts
- Background task in main.rs that runs automatically every 5 minutes (configurable)
- Auto-seeds NEAR balance for accounts with no existing records
- Graceful error handling - continues with next account/token on failures
- Updates `last_synced_at` timestamp after successful processing

**Key features:**
- Queries enabled accounts ordered by last_synced_at (prioritizes least-recently-synced)
- For each account:
  - Gets all known tokens from balance_changes table
  - If no tokens found, automatically adds "near" to seed the balance
  - Runs fill_gaps for each token up to current block
  - Updates sync timestamp after processing
- Rotates between accounts to avoid hammering single account
- Environment variable `MONITOR_INTERVAL_MINUTES` controls cycle frequency (default: 5)

**Enhanced with transaction hash capture:**
- Uses `EXPERIMENTAL_changes` RPC to capture transaction hashes
- Stores tx hashes in `transaction_hashes` field (separate from receipts)
- Captures state change cause (TransactionProcessing) in raw_data
- Resolves issue where some records had empty receipt arrays

**Integration test:** `test_continuous_monitoring`
- ✅ Validates monitoring cycle processes enabled accounts
- ✅ Verifies last_synced_at timestamp updates
- ✅ Confirms balance changes are collected
- ✅ Tests disabled accounts are skipped
- ✅ Works with empty initial state (auto-seeds NEAR)

**Additional test:** `test_fill_gap_with_transaction_hash_block_178148634`
- ✅ Validates transaction hash capture for specific block
- ✅ Verifies all database fields populated correctly
- ✅ Confirms tx hash matches expected value

**Review criteria:**
- ✅ Clear monitoring loop logic
- ✅ Graceful error handling
- ✅ Updates sync status after processing
- ✅ Integration test validates behavior
- ✅ Automatic background execution on server startup

---

## Phase 12: Token Discovery - NEAR Native ✅ COMPLETED

**Goal:** Discover NEAR balance changes for an account.

**Implementation:** Integrated into `account_monitor.rs` via auto-seed logic

**Approach taken:**
- Every monitored account automatically has "near" token in its tokens list
- Auto-seed logic in `run_monitor_cycle()` adds "near" if tokens list is empty
- This ensures NEAR balance is always checked for all monitored accounts
- No separate module needed - leverages existing balance query infrastructure

**Key code:**
```rust
// In account_monitor.rs
if tokens.is_empty() {
    println!("  {}: No known tokens, will seed NEAR balance", account_id);
    tokens.push("near".to_string());
}
```

**Testing:**
- ✅ Integration test `test_continuous_monitoring` validates auto-seeding
- ✅ Works from completely empty state (no initial records)
- ✅ NEAR balance changes automatically discovered and collected

**Review criteria:**
- ✅ NEAR native token always monitored
- ✅ Integration test validates real behavior
- ✅ Graceful handling of new accounts

---

## Phase 13: Token Discovery - Fungible Tokens

**Goal:** Discover FT tokens from NEAR balance changes.

**Add to:** `src/handlers/balance_changes/token_discovery.rs`

**TDD approach:**
1. Collect real FT transfer receipt from mainnet (from test data)
2. Write test with this receipt
3. Implement FT discovery
4. Test extracts correct token IDs

**Function:**
```rust
pub async fn discover_ft_tokens_from_receipt(
    receipt: &serde_json::Value,
) -> Result<Vec<String>>
```

**Test fixtures:**
- Receipt with FT transfer event → extracts token
- Receipt with multiple FT events → extracts all
- Receipt with no FT events → returns empty
- Malformed event → handles gracefully

**Review criteria:**
- Parses NEP-141 event format correctly
- Tests use real receipt examples
- Handles malformed events gracefully

---

## Phase 14: Token Discovery - NEAR Intents

**Goal:** Poll NEAR Intents for token holdings.

**Add to:** `src/handlers/balance_changes/token_discovery.rs`

**TDD approach:**
1. Write integration test querying real Intents contract
2. Implement polling functions
3. Test validates correct data retrieval

**Function:**
```rust
pub async fn poll_intents_tokens(
    account_id: &str,
) -> Result<HashMap<String, String>> // token_id -> balance
```

**Integration test:**
```rust
#[tokio::test]
async fn test_poll_intents_real_account() {
    let tokens = poll_intents_tokens(
        "known-account.near"
    ).await.unwrap();
    // Validate structure
}
```

**Review criteria:**
- Calls mt_tokens_for_owner and mt_batch_balance_of
- Integration test validates real contract calls
- Clear separation from transaction-based discovery

---

## Phase 15: Third-Party API Client - Nearblocks (Optional Optimization)

**Goal:** Query transaction data from Nearblocks API to speed up gap filling.

**New module:** `src/handlers/balance_changes/api_clients/nearblocks.rs`

**TDD approach:**
1. Write integration test with real API (marked `#[ignore]`)
2. Write unit tests with mocked HTTP responses
3. Implement client
4. Tests pass

**Functions:**
```rust
pub struct NearBlocksClient {
    // configuration, rate limiter
}

impl NearBlocksClient {
    pub async fn get_transactions(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: i64,
        to_block: i64,
    ) -> Result<Vec<TransactionInfo>>
}
```

**Integration test:**
```rust
#[tokio::test]
async fn test_nearblocks_real_query() {
    let client = NearBlocksClient::new();
    let txs = client.get_transactions(
        "webassemblymusic-treasury.sputnik-dao.near",
        "NEAR",
        150000000, // Block from test data range
        150010000,
    ).await.unwrap();
    // Validate response structure
}
```

**Review criteria:**
- Clean API abstraction
- In-memory result caching
- Rate limit handling (returns specific error type)
- Integration test demonstrates real usage

---

## Phase 16: Third-Party API Client - Pikespeak (Optional Optimization)

**Goal:** Query transaction data from Pikespeak API.

**New module:** `src/handlers/balance_changes/api_clients/pikespeak.rs`

**TDD approach:**
1. Write integration test
2. Write unit tests with mocked responses
3. Implement client with same interface as Nearblocks
4. Tests pass

**Review criteria:**
- Consistent interface with Nearblocks client
- Shared traits if patterns emerge
- Integration test validates real API usage

---

## Phase 17: Third-Party API Client - NEAR Intents (Optional Optimization)

**Goal:** Query transaction data from NEAR Intents explorer.

**New module:** `src/handlers/balance_changes/api_clients/near_intents.rs`

**TDD approach:**
1. Write integration tests for both transaction queries and balance polls
2. Write unit tests with mocked responses
3. Implement client
4. Tests pass

**Additional functions:**
```rust
pub async fn get_tokens_for_owner(
    &self,
    account_id: &str,
) -> Result<Vec<String>>

pub async fn get_batch_balances(
    &self,
    account_id: &str,
    token_ids: &[String],
) -> Result<HashMap<String, String>>
```

**Integration tests:**
- Query transactions for known account
- Poll tokens for owner
- Get batch balances

**Review criteria:**
- Supports both transaction queries and direct balance polling
- Clear separation between transaction API and view calls
- All integration tests validate real contract behavior

---

## Phase 18: API Coordinator (Optional Optimization)

**Goal:** Orchestrate API calls with fallback logic to speed up gap filling.

**New module:** `src/handlers/balance_changes/api_coordinator.rs`

**TDD approach:**
1. Write integration test with real APIs
2. Write unit tests simulating rate limits and failures
3. Implement fallback chain
4. Tests validate correct fallback behavior

**Function:**
```rust
pub async fn find_last_transaction_in_range(
    account_id: &str,
    token_id: &str,
    from_block: i64,
    to_block: i64,
) -> Result<Option<i64>>
```

**Unit test scenarios:**
- Nearblocks succeeds → uses it
- Nearblocks rate limited → tries Pikespeak
- All rate limited → falls back to RPC binary search
- API returns data → caches it

**Review criteria:**
- Clear fallback chain (APIs → RPC)
- Well-documented error types
- Tests demonstrate all fallback paths

---

## Implementation Order Notes

- **TDD is mandatory:** Write tests before implementation in every phase
- **Documentation is mandatory:** Each phase includes module-level docs and inline comments
- Each phase should be a separate PR for easy review
- Integration tests start in Phase 1 and grow with each phase
- Keep functions small (ideally < 50 lines, max 80 lines)
- Use helper functions to break up complex logic
- Add inline comments explaining "why", not "what"
- Each module should have module-level documentation explaining its purpose
- All integration tests should run in CI with proper environment setup

## Quick Start Recommendation

**Phases 1-4 can be implemented immediately** using existing test data:

The `test-webassemblymusic-treasury.json` file contains complete balance chain data with:
- Continuous balance_before/balance_after sequences
- Multiple token types (NEAR, FT, Intents)
- Real transaction data

**Important:** Do NOT rely on the `verificationWithNext` field in the test data. It's derived data that could be incorrect. Instead, implement proper gap detection that compares consecutive records' balances.

**Approach:**
1. Use existing `balance_changes_test.rs` as the integration test base
2. Load test data into database (already working)
3. Delete specific records to create artificial gaps
4. Implement gap detection with SQL window functions
5. Verify detected gaps match what was deleted
6. Validate that connected chains show zero gaps

**Gap detection validates:**
- `balance_after` of record[i] equals `balance_before` of record[i+1]
- For same account_id and token_id
- Ordered by block_height

This provides immediate validation of the core gap-detection algorithm without needing external APIs or RPC calls.
