# Transfer Hints Provider

The Transfer Hints system accelerates balance change detection by using FastNear's transfers-api to get pre-indexed transfer data. Instead of binary searching through potentially millions of blocks to find balance changes, the system uses "hints" from FastNear that tell us approximately where transfers occurred.

## Overview

### The Problem

When monitoring an account for balance changes, we need to find the exact blocks where the balance changed. A naive approach would check every block, which is impractical. Binary search is better but still requires `O(log n)` RPC calls for each gap.

### The Solution

FastNear maintains an index of all transfers on NEAR. We query this index to get "hints" - blocks where transfers involving our account occurred. These hints dramatically reduce the search space.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Balance Change Detection                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TransferHintService                               │
│  - Aggregates hints from multiple providers                              │
│  - Deduplicates and sorts by block height                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        FastNearProvider                                  │
│  - Converts block range → timestamp range                                │
│  - Queries transfers.main.fastnear.com                                   │
│  - Paginates through all results                                         │
│  - Filters by token type (NEAR, FT, Mt)                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Gap Filler                                      │
│  - Receives hints for a block range                                      │
│  - Verifies each hint via RPC (get_balance_at_block)                     │
│  - Falls back to binary search if no hints found                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## FastNear Transfers API

### API Endpoint

```
POST https://transfers.main.fastnear.com/v0/transfers
```

### Request Format

```json
{
  "account_id": "shitzu.sputnik-dao.near",
  "from_timestamp_ms": 1767149352073,
  "to_timestamp_ms": 1767485953392
}
```

**Important:** The API uses **timestamps in milliseconds**, not block heights. The provider converts block heights to timestamps by querying the NEAR RPC for the block's timestamp.

### Example: Query NEAR Transfers

```bash
curl -X POST "https://transfers.main.fastnear.com/v0/transfers" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FASTNEAR_API_KEY" \
  -d '{
    "account_id": "shitzu.sputnik-dao.near",
    "from_timestamp_ms": 1767149352073,
    "to_timestamp_ms": 1767485953392
  }'
```

### Example Response

```json
{
  "resume_token": null,
  "transfers": [
    {
      "account_id": "shitzu.sputnik-dao.near",
      "action_index": 0,
      "amount": "100000000000000000000000",
      "asset_id": "native:near",
      "asset_type": "Near",
      "block_height": "179253694",
      "block_timestamp": "1767259167010382617",
      "end_of_block_balance": "96336529664427419381024834",
      "human_amount": 0.09999999999999999,
      "method_name": "add_proposal",
      "other_account_id": "marior.near",
      "predecessor_id": "marior.near",
      "receipt_id": "3Eq1fszV6jW5yJFEpz3U2xfhUNYCh6vhdjTmZhwB2puZ",
      "signer_id": "marior.near",
      "start_of_block_balance": "96236483239468617081024834",
      "transaction_id": "D3TtPD1nbjbq3UcUPsymQUP5zsuhxRX9GG8eRyGM2dHG",
      "transfer_type": "AttachedDeposit",
      "usd_amount": 0.152
    },
    {
      "account_id": "shitzu.sputnik-dao.near",
      "action_index": 0,
      "amount": "-100000000000000000000000",
      "asset_id": "native:near",
      "asset_type": "Near",
      "block_height": "179276525",
      "block_timestamp": "1767273179000799870",
      "end_of_block_balance": "96336811435147844181024834",
      "human_amount": -0.09999999999999999,
      "method_name": null,
      "other_account_id": "marior.near",
      "predecessor_id": "shitzu.sputnik-dao.near",
      "receipt_id": "8SVstk7GxHfwJTksAsMNXYH8aKXQPBwPeFrhQ35pVyWy",
      "signer_id": "fiatisabubble.near",
      "start_of_block_balance": "96336811435147844181024834",
      "transaction_id": "8gcXyRhxEsjgS9qaP8UKcszqomMw5Zx5p1p3WH3QQLuV",
      "transfer_type": "NativeTransfer",
      "usd_amount": -0.152
    }
  ]
}
```

## Supported Asset Types

### 1. Native NEAR (`asset_type: "Near"`)

```json
{
  "asset_type": "Near",
  "asset_id": "native:near",
  "amount": "100000000000000000000000",
  "transfer_type": "AttachedDeposit"
}
```

Token ID used in our system: `"near"`

### 2. Fungible Tokens (`asset_type: "Ft"`)

```json
{
  "asset_type": "Ft",
  "asset_id": "nep141:wrap.near",
  "amount": "601203160819520832568",
  "transfer_type": "FtTransfer"
}
```

Token ID used in our system: `"wrap.near"` (the contract address)

### 3. Multi-Token/Intents (`asset_type: "Mt"`)

```json
{
  "asset_type": "Mt",
  "asset_id": "nep245:intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  "amount": "178809",
  "transfer_type": "MtTransfer"
}
```

Token ID used in our system: `"intents.near:nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"`

## How Block Heights are Determined

The flow from FastNear response to `balance_changes` table entry involves several verification steps:

### Step 1: Get Hints from FastNear

```
Input: Block range [179074315, 179623909]

       ↓ Convert to timestamps via RPC

Timestamps: [1767149352073ms, 1767485953392ms]

       ↓ Query FastNear API

Output: List of hints with block_heights
```

### Step 2: Verify Hints (Three Strategies)

The gap filler tries three strategies to verify each hint:

#### Strategy 1: FastNear Balance Data

If FastNear provides `start_of_block_balance` and `end_of_block_balance`, and they differ, we know the change happened at exactly that block.

```
FastNear says:
  block_height: 179253694
  start_of_block_balance: "96236483239468617081024834"
  end_of_block_balance:   "96336529664427419381024834"

  start != end → Change happened at block 179253694

  ↓ Verify via RPC

  balance at 179253694 = 96336529664427419381024834 ✓
```

#### Strategy 2: Transaction Status Resolution

If Strategy 1 fails, use the `transaction_id` to find exact receipt execution blocks:

```
FastNear says:
  transaction_id: "D3TtPD1nbjbq3UcUPsymQUP5zsuhxRX9GG8eRyGM2dHG"

  ↓ Query tx_status RPC

  Find blocks where receipts executed on our account

  ↓ Verify balance at each block

  Found matching balance at block 179253694
```

#### Strategy 3: Direct Verification

Check balance at hint block and block-1 to confirm change:

```
Hint block: 179253694

  ↓ Get balance at block 179253694
  ↓ Get balance at block 179253693

  If different → Change happened at 179253694
```

### Step 3: Insert into balance_changes

Once verified, the record is inserted:

```sql
INSERT INTO balance_changes (
  account_id,        -- 'shitzu.sputnik-dao.near'
  token_id,          -- 'near'
  block_height,      -- 179253694  (from verified hint)
  block_timestamp,   -- 1767259167010382617 (nanoseconds)
  block_time,        -- '2025-01-01 12:00:00 UTC'
  amount,            -- 100000000000000000000000
  balance_before,    -- 96236483239468617081024834
  balance_after,     -- 96336529664427419381024834
  counterparty,      -- 'marior.near'
  transaction_hashes -- ['D3TtPD1nbjbq3UcUPsymQUP5zsuhxRX9GG8eRyGM2dHG']
)
```

## Example: Complete Flow

### Scenario

Monitor `shitzu.sputnik-dao.near` for NEAR transfers between blocks 179074315 and 179623909.

### 1. Get Block Timestamps

```bash
# Block 179074315 timestamp
curl -X POST "https://archival-rpc.mainnet.fastnear.com" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FASTNEAR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":"1","method":"block","params":{"block_id":179074315}}'

# Returns: 1767149352073193709 (nanoseconds)
# Convert to ms: 1767149352073
```

### 2. Query FastNear

```bash
curl -X POST "https://transfers.main.fastnear.com/v0/transfers" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FASTNEAR_API_KEY" \
  -d '{
    "account_id": "shitzu.sputnik-dao.near",
    "from_timestamp_ms": 1767149352073,
    "to_timestamp_ms": 1767485953392
  }'
```

### 3. Filter and Verify

From the response, filter transfers matching our criteria:
- `asset_type: "Near"` for native NEAR
- Verify each hint block via RPC

### 4. Insert Records

For each verified hint, insert a balance_changes record with:
- The exact block height where balance changed
- The balance before and after
- Transaction hash and counterparty from the hint

## Fallback Behavior

If FastNear returns no hints (or is unavailable), the system falls back to binary search:

```
No hints available
      │
      ▼
Binary search between from_block and to_block
      │
      ▼
At each midpoint, query RPC for balance
      │
      ▼
Narrow search range until exact change block found
```

This ensures the system continues working even without FastNear, just slower.

## Performance Impact

| Scenario | Without Hints | With Hints |
|----------|---------------|------------|
| 1M block range, 10 transfers | ~20 RPC calls per transfer | ~2-3 RPC calls per transfer |
| Total for 10 transfers | ~200 RPC calls | ~25 RPC calls |

The hint system reduces RPC calls by 80-90% for typical monitoring scenarios.

## Configuration

### Environment Variables

```bash
# Required: API key for authenticated FastNear requests
FASTNEAR_API_KEY=your_api_key_here

# Optional: Enable/disable transfer hints (default: true when key is set)
TRANSFER_HINTS_ENABLED=true

# Optional: Custom FastNear API base URL
TRANSFER_HINTS_BASE_URL=https://transfers.main.fastnear.com
```

### Code Usage

```rust
use nt_be::handlers::balance_changes::transfer_hints::{
    TransferHintService, fastnear::FastNearProvider
};

// Create provider with API key
let provider = FastNearProvider::new(network)
    .with_api_key("your_api_key");

// Create service
let service = TransferHintService::new()
    .with_provider(provider);

// Get hints for a block range
let hints = service
    .get_hints("account.near", "near", from_block, to_block)
    .await;
```
