# Treasury26 Backend - Balance Change APIs

## Overview

The Balance Change Collection system automatically tracks balance changes for NEAR accounts across multiple token types:
- **NEAR** - Native NEAR token
- **FT Tokens** - NEP-141 fungible tokens (automatically discovered from receipts)
- **Intents Tokens** - Multi-token balances on intents.near (NEP-141 and NEP-245)
- **Staking Rewards** - Exact block where staking rewards were earned

## Quick Start

### 1. Register an Account for Monitoring

**Production** (https://near-treasury-backend.onrender.com):
```bash
curl -X POST https://near-treasury-backend.onrender.com/api/monitored-accounts \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "your-treasury.sputnik-dao.near",
    "enabled": true
  }'
```

**Local development**:
```bash
curl -X POST http://localhost:3000/api/monitored-accounts \
  -H "Content-Type: application/json" \
  -d '{
    "account_id": "webassemblymusic-treasury.sputnik-dao.near",
    "enabled": true
  }'
```

Or in JavaScript:
```javascript
fetch("/api/monitored-accounts", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    account_id: "webassemblymusic-treasury.sputnik-dao.near",
    enabled: true
  })
})
```

### 2. Query Balance Changes

Get all balance changes for an account:
```bash
curl "http://localhost:3000/api/balance-changes?account_id=webassemblymusic-treasury.sputnik-dao.near"
```

Filter by token:
```bash
curl "http://localhost:3000/api/balance-changes?account_id=webassemblymusic-treasury.sputnik-dao.near&token_id=near"
```

Paginate results:
```bash
curl "http://localhost:3000/api/balance-changes?account_id=webassemblymusic-treasury.sputnik-dao.near&page=1&limit=50"
```

Exclude snapshot records (get only actual transactions and staking rewards):
```bash
curl "http://localhost:3000/api/balance-changes?account_id=webassemblymusic-treasury.sputnik-dao.near&exclude_snapshots=true"
```

### 3. Query Staking Rewards

Get staking rewards with exact block where they were earned:
```bash
curl "http://localhost:3000/api/balance-changes?account_id=your-account.near&token_id=staking:pool.near&exclude_snapshots=true"
```

Example staking reward response:
```json
{
  "block_height": 182449384,
  "block_time": "2026-01-24T00:19:08.761126Z",
  "token_id": "staking:astro-stakers.poolv1.near",
  "counterparty": "STAKING_REWARD",
  "amount": "0.040456086036518156197191",
  "balance_before": "1029.479523405233304042477556",
  "balance_after": "1029.519979491269822198674747"
}
```

## How It Works

### Automatic Token Discovery

Once an account is registered:

1. **NEAR Token**: Automatically tracked from the start
2. **FT Tokens**: Discovered from transaction receipts (e.g., when NEAR interacts with `token.near`)
3. **Intents Tokens**: Discovered by querying `mt_tokens_for_owner` on `intents.near`

### Monitoring Cycle

The system runs periodic monitoring cycles that:
- Fill gaps in balance history using binary search
- Discover new tokens automatically
- Track counterparty information for each change
- Capture transaction hashes and receipt IDs

### Balance Change Record

Each balance change includes:
- `block_height` - Block where the change occurred
- `block_time` - Timestamp of the block
- `token_id` - Token identifier (e.g., `near`, `usdc.near`, `intents.near:nep141:btc.omft.near`)
- `balance_before` - Balance before the change
- `balance_after` - Balance after the change
- `amount` - Change amount (balance_after - balance_before)
- `counterparty` - The other party in the transaction
- `transaction_hashes` - Associated transaction hashes
- `signer_id` - Transaction signer
- `receiver_id` - Transaction receiver

## API Reference

### Register Account

**POST** `/api/monitored-accounts`

Request body:
```json
{
  "account_id": "account.near",
  "enabled": true
}
```

### Get Balance Changes

**GET** `/api/balance-changes`

Query parameters:
- `account_id` (required) - Account to query
- `token_id` (optional) - Filter by specific token
- `page` (optional) - Page number (default: 0)
- `limit` (optional) - Results per page (default: 100)
- `from_block` (optional) - Filter from block height
- `to_block` (optional) - Filter to block height
- `exclude_snapshots` (optional) - When `true`, excludes `SNAPSHOT` and `STAKING_SNAPSHOT` records

Response:
```json
{
  "changes": [
    {
      "block_height": 165324279,
      "block_time": "2024-09-24T12:00:00Z",
      "token_id": "intents.near:nep141:btc.omft.near",
      "balance_before": "584253",
      "balance_after": "564253",
      "amount": "-20000",
      "counterparty": "webassemblymusic-treasury.sputnik-dao.near",
      "transaction_hashes": ["..."],
      "signer_id": "petersalomonsen.near",
      "receiver_id": "intents.near"
    }
  ],
  "total": 1,
  "page": 0,
  "limit": 100
}
```

## Development

### Run Tests

```bash
# Run all tests
cargo test

# Run integration tests
cargo test --test balance_collection_integration_test

# Run specific test
cargo test test_discover_intents_tokens_webassemblymusic_treasury -- --nocapture
```

### Database Setup

See [DATABASE.md](./DATABASE.md) for PostgreSQL setup instructions.

## Token Format

### FT Tokens
Simple contract address: `wrap.near`, `token.v2.ref-finance.near`

### Intents Tokens
Full path format: `intents.near:nep141:btc.omft.near`
- Preserves the underlying FT contract for metadata queries
- Format: `intents.near:{standard}:{ft_contract}`

### Staking Tokens
Full path format: `staking:pool.poolv1.near`
- Format: `staking:{pool_contract}`
- Records with `counterparty: STAKING_SNAPSHOT` are epoch boundary snapshots
- Records with `counterparty: STAKING_REWARD` show exact block where reward was earned

## Record Types

| Token Type | Counterparty | Description |
|------------|--------------|-------------|
| `near` | account address | NEAR token transfer with counterparty |
| `near` | `SNAPSHOT` | Initial balance snapshot (no transaction) |
| `ft-contract.near` | account address | Fungible token transfer |
| `intents.near:nep141:*` | account address | Intents token transfer |
| `staking:pool.near` | `STAKING_SNAPSHOT` | Epoch boundary snapshot |
| `staking:pool.near` | `STAKING_REWARD` | Exact block of staking reward |
