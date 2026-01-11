# NEAR Treasury Sandbox

Local development environment for testing the bulk payment contract and API.

## Overview

This sandbox provides a complete local testing environment with:

- NEAR Sandbox (local blockchain)
- Treasury Backend API
- PostgreSQL database
- Pre-deployed contracts:
  - `bulk-payment.near` - Bulk payment contract
  - `sputnik-dao.near` - Sputnik DAO factory

## Quick Start

### Using Docker Compose

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Manual Setup

1. **Start NEAR Sandbox**:
   ```bash
   # Using near-sandbox
   near-sandbox --root ~/.near-sandbox init
   near-sandbox --root ~/.near-sandbox run
   ```

2. **Deploy Contracts**:
   ```bash
   # Build bulk payment contract
   cd ../contracts/bulk-payment
   cargo near build

   # Deploy to sandbox
   near deploy bulk-payment.near ./target/near/bulk_payment_contract.wasm \
     --networkId sandbox --nodeUrl http://localhost:3030
   ```

3. **Start Backend**:
   ```bash
   cd ../nt-be
   NEAR_RPC_URL=http://localhost:3030 cargo run
   ```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEAR_RPC_URL` | `http://localhost:3030` | NEAR RPC endpoint |
| `BULK_PAYMENT_CONTRACT_ID` | `bulk-payment.near` | Bulk payment contract |
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `API_PORT` | `8080` | API server port |

### Genesis Accounts

The sandbox comes with pre-configured test accounts:

- `test.near` - Genesis account with funds
- `sputnik-dao.near` - DAO factory contract

Default genesis key (for test.near):
```
ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB
```

## Running E2E Tests

With the sandbox running:

```bash
cd ../e2e-tests/bulk-payment
npm install
npm test
```

## Services

### NEAR Sandbox (Port 3030)

Local NEAR blockchain with instant finality.

### Treasury API (Port 8080)

REST API endpoints:
- `GET /health` - Health check
- `POST /api/bulk-payment/submit-list` - Submit payment list
- `GET /api/bulk-payment/list/:id` - Get list status
- `GET /api/bulk-payment/list/:id/transactions` - Get transactions

### PostgreSQL (Port 5432)

Database for the treasury backend.

## Troubleshooting

### Sandbox won't start
```bash
# Reset sandbox state
rm -rf ~/.near-sandbox
near-sandbox --root ~/.near-sandbox init
```

### Contract deployment fails
Ensure the sandbox is fully initialized before deploying contracts.

### API connection refused
Wait for all services to be healthy:
```bash
docker-compose ps
```
