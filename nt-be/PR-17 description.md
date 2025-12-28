This is the description for https://github.com/NEAR-DevHub/treasury26/pull/17.

Since the PR is massive, let's make it simple for the reviewer. Here is my idea.

feat: Balance Change Collection System
======================================

This is a massive PR, so it might be overwhelming to review. I will try to describe it briefly and concisely.

## What This Does

Provides APIs for accounting export data and balance history charts by automatically tracking all balance changes in a PostgreSQL database. The system:

- Tracks balance changes per block, account, and token
- Detects missing records ("gaps") by comparing consecutive balances
- Fills gaps using RPC binary search (no external APIs required)
- Runs automatic background monitoring every 5 minutes

## Token Types Supported

- **NEAR** - Native NEAR token (always tracked)
- **FT Tokens** - NEP-141 fungible tokens (auto-discovered from receipts)
- **Intents Tokens** - Multi-token balances on intents.near (auto-discovered via polling)

## How It Works

To explain it simply: The method involves making balance snapshots of the tokens we discover, and then scan for gaps. If we find gaps, we search for the blocks in between that caused the change using RPC binary search.

## Quick Example

```bash
# Register an account
curl -X POST http://localhost:3000/api/monitored-accounts \
  -H "Content-Type: application/json" \
  -d '{"account_id": "treasury.near", "enabled": true}'

# Query balance changes
curl "http://localhost:3000/api/balance-changes?account_id=treasury.near&token_id=near"
```

## Database Changes

- New table: `balance_changes` - Stores all balance change records
- New table: `monitored_accounts` - Controls which accounts to monitor

## Testing

Integration tests use real mainnet data and run full monitoring cycles end-to-end. Tests validate:
- Gap detection and filling
- FT token discovery from receipts
- Intents token discovery from contract queries
- Balance change tracking with counterparty information

## Documentation

- [README](https://github.com/petersalomonsen/treasury26/blob/feat/balance-change-collection/nt-be/README.md) - API usage examples and quick start
- [Implementation Plan](https://github.com/petersalomonsen/treasury26/blob/feat/balance-change-collection/docs/implementation-plans/balance-change-phases.md) - Detailed phase-by-phase breakdown

## Future Work

Next PRs will add optional APIs from nearblocks and pikespeak to speed up data fetching. The current RPC binary search is the fallback, but we'll use external APIs to speed up and verify when available.

