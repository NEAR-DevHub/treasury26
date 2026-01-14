# E2E Tests for DAO Bulk Payment Flow

This directory contains end-to-end tests that demonstrate the full workflow for bulk payments from a DAO's perspective, including scenarios with non-registered and non-existent accounts.

## Test Files

### 1. `dao-bulk-payment-flow.js`
Main test for native NEAR token payments with mixed account types:
- **Implicit accounts** (64-char hex): Should succeed
- **Created named accounts**: Should succeed
- **Non-existent named accounts**: Should have failed transaction receipts but still marked as processed

### 2. `fungible-token-non-registered-flow.js`
Test for fungible token (wrap.near) payments:
- **Registered recipients**: Should succeed with balance changes
- **Non-registered recipients**: Should have failed receipts, no balance changes

### 3. `near-intents-non-registered-flow.js`
Test for NEAR Intents token (nep141:wrap.near) payments:
- **Registered recipients**: Should succeed with balance changes
- **Non-registered recipients**: Should have failed receipts, no balance changes

## Test Behavior

All tests verify that:
1. **All payments are processed** - Every payment gets a block_height regardless of success/failure
2. **Successful transfers** - Registered/existing accounts show balance changes and successful transaction receipts
3. **Failed transfers** - Non-registered/non-existent accounts have failed receipts but are still marked as processed

## Prerequisites

- Node.js 20+
- Docker (for local testing)
- Access to a running sandbox environment

## Configuration

The tests can be configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_RPC_URL` | `http://localhost:3030` | URL of the NEAR sandbox RPC |
| `API_URL` | `http://localhost:8080` | URL of the bulk payment API |
| `DAO_FACTORY_ID` | `sputnik-dao.near` | Sputnik DAO factory account |
| `BULK_PAYMENT_CONTRACT_ID` | `bulk-payment.sandbox` | Bulk payment contract account |
| `NUM_RECIPIENTS` | `500` | Number of payment recipients (dao-bulk-payment-flow.js) |
| `PAYMENT_AMOUNT` | `100000000000000000000000` | Amount per recipient (0.1 NEAR) |

## Running Tests

### Against Local Docker Container

```bash
# Build and start the Docker container
docker build -t near-treasury-sandbox -f sandbox/Dockerfile .
docker run -d --name sandbox -p 3030:3030 -p 8080:8080 -p 5001:5001 near-treasury-sandbox

# Wait for services to start
sleep 30

# Run all tests
cd e2e-tests
npm install
npm run test:all:docker

# Or run individual tests
npm run test:docker                    # Native NEAR with mixed accounts
npm run test:fungible-token:docker     # Fungible tokens (wrap.near)
npm run test:near-intents:docker       # NEAR Intents tokens
```

### Against Fly.io Deployment

```bash
cd e2e-tests
npm install

# Run against the deployed Fly.io sandbox
SANDBOX_RPC_URL=https://near-treasury-sandbox.fly.dev:3030 \
API_URL=https://near-treasury-sandbox.fly.dev:8080 \
npm test
```

### GitHub Actions

The test runs automatically via GitHub Actions on:
- Push to `main` or `staging` branches
- Pull requests to `main` or `staging` branches
- Manual workflow dispatch (with optional Fly.io URL)

## Test Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           E2E Test Flow                                  │
└─────────────────────────────────────────────────────────────────────────┘

     ┌──────────────┐
     │ Genesis      │
     │ Account      │
     └──────┬───────┘
            │
            ▼
┌───────────────────────────────┐
│ 1. Create DAO                 │
│    testdao.sputnik-dao.near   │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ 2. Proposal: buy_storage      │
│    - 500 records              │
│    - Attached deposit         │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ 3. Approve buy_storage        │
│    (VoteApprove)              │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐       ┌─────────────────────┐
│ 4. Submit payment list        │──────▶│ Bulk Payment API    │
│    POST /submit-list          │       │ - Validates list    │
│    - 500 recipients           │       │ - Returns list_id   │
└──────────────┬────────────────┘       └─────────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ 5. Proposal: approve_list     │
│    - list_ref: <list_id>      │
│    - Attached deposit: 50 NEAR│
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ 6. Approve list proposal      │
│    (VoteApprove)              │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐       ┌─────────────────────┐
│ 7. Background Worker          │◀──────│ Bulk Payment API    │
│    - Polls every 5s           │       │ Worker Thread       │
│    - Calls payout_batch       │       └─────────────────────┘
│    - 100 payments per batch   │
└──────────────┬────────────────┘
               │
               ▼
┌───────────────────────────────┐
│ 8. Verify recipients          │
│    - Check all have block_height
│    - Verify transaction receipts│
│    - Check balances           │
└───────────────────────────────┘
```

## Test Scenarios

### Native NEAR Payments (dao-bulk-payment-flow.js)
- **Implicit accounts** (64-char hex): All succeed, balances updated
- **Created named accounts**: All succeed, balances updated
- **Non-existent named accounts**: Transaction receipts show failure, no balances

### Fungible Token Payments (fungible-token-non-registered-flow.js)
- **Registered accounts**: Successful transfers, token balances updated
- **Non-registered accounts**: Failed receipts, no token balance changes

### NEAR Intents Payments (near-intents-non-registered-flow.js)
- **Registered accounts**: Successful ft_withdraw calls, balances updated
- **Non-registered accounts**: Failed receipts, no balance changes

## Files

- `package.json` - npm package configuration
- `dao-bulk-payment-flow.js` - Main test for native NEAR with mixed accounts
- `fungible-token-non-registered-flow.js` - Test for fungible tokens with non-registered recipients
- `near-intents-non-registered-flow.js` - Test for NEAR Intents with non-registered recipients
- `README.md` - This documentation

## Related

- [Sandbox Environment](../sandbox/README.md) - Docker deployment configuration
- [Bulk Payment API](../bulk-payment-api/README.md) - REST API documentation
- [Bulk Payment Contract](../src/lib.rs) - Smart contract implementation
