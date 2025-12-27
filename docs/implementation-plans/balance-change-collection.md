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
Recording Balance Changes

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

## Database Schema Changes

**Required Migration:** Rename the `raw_data` JSONB column to `receipt` to better reflect its purpose of storing full receipt data including logs and events.

**Field Definitions:**
- `actions`: Transaction arguments from the initiating block
- `receipt`: Full receipt data with logs and events/outcomes
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

- [ ] Database migration: Rename `raw_data` to `receipt`
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

