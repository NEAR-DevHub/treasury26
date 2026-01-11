# Bulk Payment E2E Tests

End-to-end tests for the NEAR Treasury Bulk Payment Contract with DAO integration.

## Prerequisites

- Node.js 18+
- Running NEAR sandbox environment
- Deployed bulk payment contract
- Deployed Sputnik DAO factory

## Installation

```bash
npm install
```

## Running Tests

### Basic DAO Flow Test

Tests the complete flow: DAO creation, storage purchase, payment list submission, approval, and payout processing.

```bash
npm test
```

### Fungible Token Tests

Test large batch fungible token payments:

```bash
npm run test:ft
```

Test payments to non-registered accounts:

```bash
npm run test:ft-non-registered
```

### NEAR Intents Tests

Test NEAR Intents token payments:

```bash
npm run test:intents
```

### Run All Tests

```bash
npm run test:all
```

## Configuration

Tests can be configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_RPC_URL` | `http://localhost:3030` | NEAR sandbox RPC endpoint |
| `API_URL` | `http://localhost:8080` | Bulk payment API endpoint |
| `DAO_FACTORY_ID` | `sputnik-dao.near` | Sputnik DAO factory contract |
| `BULK_PAYMENT_CONTRACT_ID` | `bulk-payment.near` | Bulk payment contract |
| `NUM_RECIPIENTS` | `250` | Number of recipients in test |
| `PAYMENT_AMOUNT` | `100000000000000000000000` | Payment amount per recipient (yoctoNEAR) |
| `GENESIS_ACCOUNT_ID` | `test.near` | Genesis account for sandbox |
| `GENESIS_PRIVATE_KEY` | (sandbox default) | Private key for genesis account |

## Docker Integration

For running against a containerized sandbox:

```bash
npm run test:docker
```

## Test Scenarios

### dao-bulk-payment-flow.js

1. Creates a test DAO
2. Purchases storage credits for the DAO
3. Generates a payment list with mixed recipient types:
   - Implicit accounts (succeed)
   - Created named accounts (succeed)
   - Non-existent named accounts (fail)
4. Creates and approves DAO proposals
5. Submits payment list via API
6. Verifies all payments are processed
7. Validates transaction receipts

### fungible-token-large-batch.js

Tests large batch (50-500) fungible token payments using wrap.near.

### fungible-token-non-registered-flow.js

Tests behavior when paying to accounts not registered with the token contract.

### near-intents-non-registered-flow.js

Tests NEAR Intents (intents.near) multi-token payments with mixed registration status.
