# NEAR Treasury Sandbox

Local development environment for testing the bulk payment contract and treasury API.

## Overview

This sandbox provides a complete local testing environment with:

- **NEAR Sandbox**: Local NEAR blockchain with instant finality
- **Treasury Backend (nt-be)**: REST API for bulk payment operations
- **Sputnik DAO Indexer**: Proposal caching service
- **PostgreSQL**: Database for the treasury backend
- **Pre-deployed contracts**:
  - `bulk-payment.near` - Bulk payment contract
  - `sputnik-dao.near` - Sputnik DAO factory
  - `wrap.near` - Wrapped NEAR token
  - `intents.near` - NEAR Intents multi-token

## Quick Start

### Using Docker (Recommended)

```bash
# Build the sandbox image
docker build -t near-treasury-sandbox .

# Run the sandbox
docker run -d \
  --name sandbox \
  -p 3030:3030 \
  -p 8080:8080 \
  -p 5001:5001 \
  near-treasury-sandbox

# Check health
curl http://localhost:8080/health
```

### Using Docker Compose (Development)

```bash
docker-compose up -d
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ NEAR        │  │ Treasury    │  │ Sputnik Indexer     │ │
│  │ Sandbox     │  │ Backend     │  │ (proposal cache)    │ │
│  │ :3031→3030  │  │ :8080       │  │ :5001               │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         │                │                    │             │
│         └────────────────┼────────────────────┘             │
│                          │                                   │
│                   ┌──────┴──────┐                           │
│                   │ PostgreSQL  │                           │
│                   │ :5432       │                           │
│                   └─────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 3030 | NEAR RPC | NEAR blockchain JSON-RPC |
| 8080 | Treasury API | REST API for bulk payments |
| 5001 | Sputnik Indexer | DAO proposal caching |
| 5432 | PostgreSQL | Database (internal) |

## API Endpoints

### Health Check
```bash
curl http://localhost:8080/health
```

### Bulk Payment Endpoints
```bash
# Submit a payment list
curl -X POST http://localhost:8080/api/bulk-payment/submit-list \
  -H "Content-Type: application/json" \
  -d '{"list_id": "...", "submitter_id": "...", ...}'

# Get list status
curl http://localhost:8080/api/bulk-payment/list/{list_id}

# Get transactions
curl http://localhost:8080/api/bulk-payment/list/{list_id}/transactions
```

## Genesis Accounts

The sandbox comes with pre-configured test accounts:

| Account | Description |
|---------|-------------|
| `test.near` | Genesis account with ~1B NEAR |

**Genesis Private Key** (for test.near):
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

## Adding Contract WASM Files

Place the following WASM files in `sandbox/contracts/`:

- `bulk_payment.wasm` - Built from `contracts/bulk-payment/`
- `wrap_near.wasm` - NEP-141 wrapped NEAR
- `intents.wasm` - NEAR Intents multi-token
- `sputnik_dao_factory.wasm` - Sputnik DAO factory

The bulk payment contract is built automatically during the Docker build.

## Troubleshooting

### Container won't start
```bash
# Check logs
docker logs sandbox

# Restart fresh
docker rm -f sandbox
docker run -d --name sandbox -p 3030:3030 -p 8080:8080 near-treasury-sandbox
```

### API returns 500 errors
Wait for all services to initialize (30-60 seconds after container start).

### Contract deployment fails
Ensure the WASM files exist in `sandbox/contracts/`.

## Building from Source

```bash
# Build the sandbox-init tool
cd sandbox/sandbox-init
cargo build --release

# Build the bulk payment contract
cd ../../contracts/bulk-payment
cargo near build non-reproducible-wasm
```
