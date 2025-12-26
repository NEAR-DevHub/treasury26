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

## Phase 1: Integration Test Infrastructure

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

## Phase 2: Database Schema Update

---

## Phase 2: Database Schema Update

**Goal:** Rename `raw_data` to `receipt` to better reflect its purpose.

**Files to modify:**
- `migrations/20251223000001_create_balance_changes.sql`

**TDD approach:**
1. Update integration test to use `receipt` field
2. Run migration
3. Verify test passes

**Review criteria:**
- Migration runs successfully
- Column renamed with no data loss
- Integration test passes

---

## Phase 3: Core Data Structures

**Goal:** Define Rust types for balance changes and gaps.

**New module:** `src/models/balance_change.rs`

**TDD approach:**
1. Add integration test that queries and inserts using new structs
2. Define structs
3. Implement sqlx traits (FromRow, etc.)
4. Test passes

**Define:**
```rust
pub struct BalanceChange {
    pub account_id: String,
    pub token_id: String,
    pub block_height: i64,
    pub block_timestamp: i64,
    pub balance_before: String,
    pub balance_after: String,
    pub counterparty: Option<String>,
    pub actions: serde_json::Value,
    pub receipt: serde_json::Value,
}

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

## Phase 4: Gap Detection Algorithm

**Goal:** Implement logic to scan existing records and find gaps.

**New module:** `src/services/gap_detector.rs`

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

## Phase 5: Balance Query Service

**Goal:** Query balance at specific block heights via RPC.

**New module:** `src/services/balance_query.rs`

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

pub async fn get_balance_change_at_block(
    account_id: &str,
    token_id: &str,
    block_height: i64,
) -> Result<(String, String)> // (before, after)
```

**Integration test:**
```rust
#[tokio::test]
#[ignore] // Requires RPC access
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

## Phase 6: Block Timestamp Service

**Goal:** Retrieve block timestamps from RPC.

**Add to:** `src/services/balance_query.rs` or new `src/services/block_info.rs`

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
- Caches results to avoid redundant calls
- Clear error handling

---

## Phase 7: Binary Search for Changes

**Goal:** Implement RPC-based binary search to find exact block of change.

**New module:** `src/services/binary_search.rs`

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

**Review criteria:**
- Clear binary search logic
- All tests pass
- Function broken into helpers if > 50 lines

---

## Phase 8: Third-Party API Client - Nearblocks

**Goal:** Query transaction data from Nearblocks API.

**New module:** `src/services/api_clients/nearblocks.rs`

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
#[ignore] // Requires API key
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

## Phase 9: Third-Party API Client - Pikespeak

**Goal:** Query transaction data from Pikespeak API.

**New module:** `src/services/api_clients/pikespeak.rs`

**TDD approach:**
1. Write integration test (marked `#[ignore]`)
2. Write unit tests with mocked responses
3. Implement client with same interface as Nearblocks
4. Tests pass

**Review criteria:**
- Consistent interface with Nearblocks client
- Shared traits if patterns emerge
- Integration test validates real API usage

---

## Phase 10: Third-Party API Client - NEAR Intents

**Goal:** Query transaction data from NEAR Intents explorer.

**New module:** `src/services/api_clients/near_intents.rs`

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

## Phase 11: API Coordinator

**Goal:** Orchestrate API calls with fallback logic.

**New module:** `src/services/api_coordinator.rs`

**TDD approach:**
1. Write integration test with real APIs (marked `#[ignore]`)
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
- All rate limited → returns appropriate error
- API returns data → caches it

**Review criteria:**
- Clear fallback chain
- Well-documented error types
- Tests demonstrate all fallback paths

---

## Phase 12: Counterparty Extraction

**Goal:** Extract counterparty from transaction receipts.

**New module:** `src/services/counterparty_extractor.rs`

**TDD approach:**
1. Collect real receipt JSON examples from mainnet (from test data)
2. Write tests with these examples
3. Implement extraction logic
4. Tests pass for all examples

**Function:**
```rust
pub fn extract_counterparty(
    receipt: &serde_json::Value,
    account_id: &str,
) -> Option<String>
```

**Test fixtures:**
- FT transfer receipt → extracts recipient
- NEAR Intents transfer → extracts counterparty
- Malformed receipt → returns None
- Multiple events → extracts correct one

**Review criteria:**
- Handles FT transfer events
- Handles NEAR Intents events
- Tests use real receipt examples
- Clear comments on event parsing logic

---

## Phase 13: Token Discovery - NEAR Native

**Goal:** Discover NEAR balance changes for an account.

**New module:** `src/services/token_discovery.rs`

**TDD approach:**
1. Write integration test with known mainnet account (from test data)
2. Implement NEAR balance check
3. Test validates balance detection

**Function:**
```rust
pub async fn check_near_balance_at_block(
    account_id: &str,
    block_height: i64,
) -> Result<Option<BalanceChange>>
```

**Integration test:**
```rust
#[sqlx::test]
#[ignore] // Requires RPC
async fn test_discover_near_balance(pool: PgPool) {
    let change = check_near_balance_at_block(
        "webassemblymusic-treasury.sputnik-dao.near",
        150000000, // Block from test data range
    ).await.unwrap();
    // Validate change is detected
}
```

**Review criteria:**
- Focused on NEAR native token only
- Integration test validates real account
- Clear error handling

---

## Phase 14: Token Discovery - Fungible Tokens

**Goal:** Discover FT tokens from NEAR balance changes.

**Add to:** `src/services/token_discovery.rs`

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

## Phase 15: Token Discovery - NEAR Intents

**Goal:** Poll NEAR Intents for token holdings.

**Add to:** `src/services/token_discovery.rs`

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
#[ignore] // Requires RPC
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

## Phase 16: Gap Filler Service

**Goal:** Main service that fills gaps using all components.

**New module:** `src/services/gap_filler.rs`

**TDD approach:**
1. Update integration test to fill actual gaps end-to-end
2. Implement orchestration
3. Test validates gaps are filled correctly

**Function:**
```rust
pub async fn fill_gaps(
    pool: &PgPool,
    account_id: &str,
    token_id: &str,
    start_block: i64,
) -> Result<usize> // returns number of gaps filled
```

**Integration test:**
```rust
#[sqlx::test]
async fn test_fill_gaps_end_to_end(pool: PgPool) {
    // Insert records with known gaps
    // Call fill_gaps
    // Verify gaps are filled
    // Verify balance chain is continuous
    Ok(())
}
```

**Review criteria:**
- Orchestrates components clearly
- Integration test demonstrates full workflow
- Error handling with context
- Functions < 60 lines

---

## Phase 17: Monitored Accounts Table

**Goal:** Create database table for accounts to monitor continuously.

**New migration:** `migrations/XXXXXX_create_monitored_accounts.sql`

**TDD approach:**
1. Write integration test that inserts and queries monitored accounts
2. Create migration
3. Add model struct
4. Tests pass

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

**Model struct:**
```rust
pub struct MonitoredAccount {
    pub account_id: String,
    pub enabled: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

**Integration test:**
```rust
#[sqlx::test]
async fn test_monitored_accounts(pool: PgPool) {
    // Insert monitored account
    // Query enabled accounts
    // Update last_synced_at after processing
    // Verify updates
}
```

**Review criteria:**
- Migration runs successfully
- Can insert and query accounts
- Index improves query performance
- Clear model struct

---

## Phase 18: Continuous Monitoring Service

**Goal:** Implement continuous monitoring loop that processes enabled accounts.

**New module:** `src/services/account_monitor.rs`

**TDD approach:**
1. Write integration test with monitored accounts
2. Implement monitoring loop
3. Test validates continuous processing

**Function:**
```rust
pub async fn run_monitor_loop(
    pool: &PgPool,
    interval_seconds: u64,
) -> Result<()>
```

**Logic:**
1. Query enabled accounts from `monitored_accounts` table
2. For each account:
   - Get current block height
   - Query all known tokens for this account from balance_changes
   - For each token:
     - Get current balance at current block
     - Get last recorded balance_after
     - If different: run gap detection and filling
   - Update `last_synced_at` timestamp
3. Rotate between accounts to avoid rate limits
4. Sleep for interval between full cycles
5. Handle errors gracefully, continue with next account

**Integration test:**
```rust
#[sqlx::test]
async fn test_continuous_monitoring(pool: PgPool) {
    // Insert monitored accounts
    // Run one cycle of monitoring
    // Verify last_synced_at updated
    // Verify balance changes collected
    // Verify accounts processed in rotation
}
```

**Review criteria:**
- Clear monitoring loop logic
- Graceful error handling
- Updates sync status after processing
- Integration test validates behavior
- No blocking operations

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
- Mark tests requiring external services with `#[ignore]` but run them during development

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
