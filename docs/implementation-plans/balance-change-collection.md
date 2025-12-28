# Balance Change Data Collection Implementation Plan

## Overview

This implementation collects balance change data for NEAR accounts to populate the `balance_changes` table. The system uses a gap-filling strategy that can resume from any point, combining third-party APIs with RPC fallback for reliable data collection.

**Reference Implementation:** A working TypeScript version exists at https://github.com/petersalomonsen/near-accounting-export/. This Rust implementation aims to improve structure and simplify the design while maintaining the same functionality.

## Core Algorithm

The data collection follows a gap-detection and filling strategy:

1. **Define Starting Point:** Choose a block_height (typically current time, but can be historical for backfilling)

2. **Check for Differences:** Compare the balance at the starting block with the previous recorded balance for that token/account
   - If no previous record exists, assume balance_before is zero (no recorded history)
   - If difference is zero: assume no changes occurred in the interval
   - If difference exists: search backwards for the block with the change

3. **Validate Continuity:** Scan existing records to find gaps where `balance_after` of one record doesn't match `balance_before` of the next record for the same token/account

4. **Fill Gaps:** Search backwards between gap boundaries to find blocks with balance changes

5. **Iterate:** Continue until all gaps are filled and records form a continuous chain

**Resume Strategy:** The system can resume at any starting point. No sync_status table is needed - scanning existing data for gaps automatically identifies what's missing.

## Backward Search Strategy

### Primary: Third-Party API Approach

Query APIs (nearblocks, pikespeak, NEAR Intents explorer) for transactions in the specified block range:
- Filter by account and token
- Order results descending
- Take the last transaction in range
- **Cache results in memory** to avoid redundant API calls

**Rate Limiting:** When APIs hit rate limits, fall back to RPC approach. Resume using APIs when they become available again.

### Fallback: RPC Binary Search

When APIs fail to resolve gaps, use archival RPC with binary search:
## Recording Balance Changes

### Data Collection per Block

For each block with a balance change:

1. **Query balances:** Get balance for the account/token on the block before and after the receipt execution
2. **Calculate difference:** Determine the amount changed
3. **Get block timestamp:** Query the block from RPC to get timestamp (see [reference implementation](https://github.com/petersalomonsen/near-accounting-export/blob/main/scripts/balance-tracker.ts#L1258))
4. **Determine counterparty:** Extract from transfer events - the account that sent or received tokens (not to be confused with transaction signer or receipt predecessor)
5. **Store transaction data:**
   - `actions` field: Transaction arguments from the initiating block
   - `receipt` field: Full receipt data including logs and events/outcomes
6. Token Discovery

### Starting with NEAR Native Balance

When no data exists, begin by checking the native NEAR balance. This reveals the account's primary activity.

### Discovering Fungible Tokens (NEP-141)

Fungible token interactions leave traces in NEAR balance changes through gas fees:
- Monitor NEAR balance changes caused by contract interactions
- When found, examine receipts (which may span multiple subsequent blocks)
- Parse receipt logs for token transfer events
- Events reveal which fungible tokens changed balances

### Discovering NEAR Intents Tokens

**Standard Case:** Follow the same pattern as fungible tokens - look for NEAR gas fees and analyze receipts.

**Special Case:** Intent resolutions can be posted by solvers without account-initiated transactions. These won't appear as transactions from the account owner.

**Solution:** Query the NEAR Intents contract directly:
- Call `mt_tokens_for_owner` to list all tokens the account holds
- Call `mt_batch_balance_of` to get current balances
- **Frequent polling:** Check at least twice per day to catch same-day transfers in/out that third-party APIs might miss

This polling acts as a safety net when APIs don't fill all gaps.

## Snapshot Records

Snapshot records are structural reference points that enable the gap detection algorithm to identify intervals where balance changes may have occurred. They use the special counterparty value `"SNAPSHOT"` to distinguish them from transactional records.

### Purpose

Snapshot records serve as boundary markers for the gap-filling algorithm:
- Provide reference points for detecting balance changes between observations
- Essential for NEAR Intents tokens where changes can occur without account-initiated transactions
- Created during regular polling intervals or when first discovering a token

### Critical Requirements

**Balance Measurement:** Snapshot records MUST have correctly measured balances:
- `balance_before`: Query the actual balance BEFORE the snapshot block
- `balance_after`: Query the actual balance AFTER the snapshot block  
- `amount`: Calculate as `balance_after - balance_before`

**Why this matters:** For fungible tokens, the transaction block and the receipt execution block (where balance actually changes) may be different. A snapshot at the transaction block would show no change (`balance_before == balance_after`, `amount = 0`), while the actual balance change occurred in a subsequent block. The gap detection algorithm uses these accurate measurements to identify which blocks need investigation.

### When Snapshots Are Created

1. **Token Discovery:** When a new token is first discovered for an account (via receipt analysis or polling)
2. **Regular Polling:** Periodic balance checks (especially for NEAR Intents to catch solver-initiated changes)
3. **Reference Points:** Strategic markers to ensure comprehensive gap detection

### Counterparty Rules

**Snapshot records:** `counterparty = "SNAPSHOT"`

**Transactional records:** MUST have an identifiable counterparty:
- Account ID (e.g., `"alice.near"`)
- Contract address (e.g., FT contract hash)
- `"system"` for protocol-level changes (gas refunds, validator rewards)

**Test Failure Criteria:** If a balance change is detected but no counterparty can be identified, this indicates a bug in the counterparty extraction logic and should fail tests. All balance changes must have traceable origins or destinations.

## The Counterparty Table

The counterparty table maintains metadata about accounts that appear as counterparties in balance changes. This enables proper classification, decimal conversion, and display of transactions.

### Purpose

1. **Account Classification:** Identify the type of each counterparty:
   - Fungible Token (NEP-141) contract
   - Staking pool
   - DAO contract (e.g., Sputnik DAO)
   - Personal account
   - System account (protocol-level operations)
   - Other contract types

2. **Token Metadata Storage:** For fungible token contracts, store essential metadata:
   - `decimals`: Number of decimal places (e.g., 6 for arizcredits.near, 24 for NEAR)
   - `symbol`: Token symbol (e.g., "ARIZ", "NEAR")
   - `name`: Full token name
   - `icon`: Optional token icon URL

3. **Decimal Conversion:** When storing FT balance changes, query the counterparty table to get the token's `decimals` field. Convert the raw amount (smallest units returned by `ft_balance_of`) to human-readable format by dividing by 10^decimals. Store the result as BigDecimal to preserve exact precision without rounding.

### Counterparty Detection

When a balance change is detected, the system attempts to determine the counterparty (the other party involved in the transfer):

**For Native NEAR transfers:** Query receipts where the account is the receiver. Extract counterparty from the receipt's `predecessor_id`.

**For FT transfers:** The counterparty information is in EVENT_JSON logs emitted by the token contract. However, retrieving these logs requires:
1. Finding the transaction hash that caused the balance change
2. Using `EXPERIMENTAL_tx_status` to get execution outcomes with logs
3. Parsing EVENT_JSON to extract the counterparty

**UNKNOWN Counterparty:** When the counterparty cannot be determined (e.g., no receipts found for the block, or receipts don't contain the necessary information), use the special value `"UNKNOWN"`. This allows the system to continue recording balance changes even when full transaction details are unavailable. The counterparty can be resolved later through:
- Third-party APIs (nearblocks, pikespeak)
- Manual investigation
- Future improvements to counterparty detection logic

Using `"UNKNOWN"` is preferable to failing to record the balance change entirely, as the primary goal is to maintain a complete chain of balance changes.

### Schema

```sql
CREATE TABLE counterparties (
    account_id TEXT PRIMARY KEY,
    account_type TEXT NOT NULL,  -- 'ft_token', 'staking_pool', 'dao', 'personal', 'system', 'unknown', 'other'
    
    -- FT token metadata (NULL for non-FT accounts)
    token_symbol TEXT,
    token_name TEXT,
    token_decimals SMALLINT,
    token_icon TEXT,
    
    -- Discovery metadata
    discovered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_verified_at TIMESTAMP,
    
    -- Additional metadata (JSONB for flexibility)
    metadata JSONB
);
```

### Balance Conversion Flow

1. Query raw balance from RPC: `ft_balance_of(account, token)` returns "2500000" (raw amount)
2. Look up token in counterparty table: `SELECT token_decimals FROM counterparties WHERE account_id = 'arizcredits.near'` returns 6
3. Convert to human-readable: `2500000 / 10^6 = 2.5`
4. Store as BigDecimal in balance_changes table: `2.5` (exact precision, no rounding)

This ensures all fungible token amounts are stored in their human-readable form with exact decimal precision, matching what users expect to see (e.g., "2.5 ARIZ" not "2500000").

### Population Strategy

- **Automatic Discovery:** When a new counterparty is encountered during balance collection:
  1. Check if it's an FT contract by calling `ft_metadata()`
  2. If successful, insert into counterparties table with `account_type = 'ft_token'` and store decimals/symbol/name
  3. If ft_metadata fails, classify as 'other' (can be reclassified later)

- **Lazy Loading:** Counterparty metadata is queried on-demand when processing balance changes. If not found, query and cache it.

- **Periodic Verification:** Optionally refresh metadata for known tokens to catch any contract updates.


## Database Schema

**Field Definitions:**
- `actions`: Transaction arguments from the initiating block
- `raw_data`: Full receipt data including logs and events/outcomes
- `counterparty`: The account that sent or received the tokens (not signer or predecessor)
- `block_height`: Receipt execution block (not transaction initiation block)
- `block_timestamp`: Timestamp from the receipt execution block

## Performance Strategy

**Sequential Processing:**
- Process one account at a time
- Process one block at a time
- Alternate between accounts to avoid hitting API rate limits

**Benefits:**
- Prevents API rate limit exhaustion
- Simpler error recovery
- Easier to reason about state

## Error Handling and Resumption

**Philosophy:** Fail fast and resume cleanly.

**On Errors (API unavailable, RPC out of sync, etc.):**
1. Exit the data collection job
2. When retriggered, scan existing data for gaps
3. Resume from gap boundaries automatically

**No Need For:**
- Sync status tracking
- Complex error retry logic
- State persistence beyond database records

The gap-detection algorithm naturally handles resumption by validating that `balance_after` of each record matches `balance_before` of the next record for the same account/token pair.

## Implementation Checklist

- [ ] Implement gap detection algorithm (scan for disconnected balance chains)
- [ ] Implement third-party API clients (nearblocks, pikespeak, NEAR Intents)
- [ ] Implement RPC binary search fallback
- [ ] Implement balance query logic (before/after receipt execution)
- [ ] Implement token discovery (NEAR, FT, Intents)
- [ ] Implement counterparty extraction from transfer events
- [ ] Implement block timestamp retrieval from RPC
- [ ] Implement in-memory API response caching
- [ ] Implement account alternation for rate limit avoidance
- [ ] Add NEAR Intents polling (twice daily)
- [ ] Integration tests with real account data
- [ ] Error handling tests (API failures, RPC unavailable)
- [ ] Resume/gap-filling tests
Since we can resume at any time, the data collection job can exit in such cases, and when retriggered, it will figure out where the gap is and start from there.

*Block timestamp*

The block timestamp is available by querying the block from RPC ( see the Typescript implementation https://github.com/petersalomonsen/near-accounting-export/blob/main/scripts/balance-tracker.ts#L1258 ).

# Performance considerations

Alternate between searching accounts, to avoid hitting rate limits. Process one account at the time, and also one block at the time.

# Reference project

A project that already does this is https://github.com/petersalomonsen/near-accounting-export/. It is written in TypeScript, but has most of the features mentioned here. In this project we want to improve the structure compared to the TypeScript implementaiton, and also simplify the implementation.

