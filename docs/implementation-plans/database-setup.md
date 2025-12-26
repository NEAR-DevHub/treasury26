NEAR Treasury Backend Postgres Database Setup
==============================================

This document describes the comprehensive database setup for the [NEAR Treasury Backend](../../nt-be/).

## Overview

The NEAR Treasury backend will use PostgreSQL as its primary database for storing:
- Treasury configuration and metadata
- Proposal data (cached from NEAR blockchain)
- User preferences and settings
- Audit logs and analytics

## Infrastructure

### Production (Render.com)
- Database is defined in [render.yaml](../../render.yaml)
- Connection string automatically injected via `DATABASE_URL` environment variable
- Free tier database plan (can be upgraded as needed)

### Development (Local Docker)
- Use Docker Compose for local development
- Separate test database for integration tests
- Should match production PostgreSQL version

## Implementation Tasks

### 1. Add Database Dependencies

Update `nt-be/Cargo.toml` to include:
```toml
sqlx = { version = "0.8", features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "chrono", "json", "migrate", "bigdecimal"] }
bigdecimal = { version = "0.4", features = ["serde"] }
uuid = { version = "1.11", features = ["v4", "serde"] }
env_logger = "0.11"
log = "0.4"
```

### 2. Database Schema Design

The primary use case is storing balance change history from [near-accounting-export](https://github.com/petersalomonsen/near-accounting-export). The data includes:
- Block/transaction metadata
- Actions array (complex nested structure)  
- Multiple token transfers per block
- Balance snapshots (before/after) per token

**Design approach**: Flattened structure with one row per token change per block. Each row represents a single token balance change, making queries simple and efficient. For blocks with multiple token changes, there will be multiple rows with the same block_height but different token_id values.

#### Schema Tables

**`balance_changes`** - Main table for balance-changing block entries
```sql
CREATE TABLE balance_changes (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL, -- normally treasury account id, but can in fact be any near account
    
    -- Block metadata
    block_height BIGINT NOT NULL,
    block_timestamp BIGINT NOT NULL,  -- Nanoseconds since epoch
    
    -- Transaction info
    transaction_block BIGINT,  -- May differ from block_height for receipts
    transaction_hashes TEXT[] NOT NULL DEFAULT '{}',
    signer_id VARCHAR(64),
    receiver_id VARCHAR(64),
    
    -- Snapshot data (use JSONB for nested structures)
    token_id VARCHAR(64),
    receipt_id  TEXT[] NOT NULL DEFAULT '{}',
    counterparty VARCHAR(64) NOT NULL, -- account that sent or received tokens from this account
    amount NUMERIC(78, 0) NOT NULL, -- positive for ingoing amounts, negative for outgoing. NUMERIC for arbitrary precision (yoctoNEAR exceeds BIGINT)
    balance_before NUMERIC(78, 0) NOT NULL, -- arbitrary precision for large token amounts
    balance_after NUMERIC(78, 0) NOT NULL, -- arbitrary precision for large token amounts
    
    -- Raw data (optional - for debugging/auditing)
    actions JSONB,  -- Store full actions array, only for the block where the transaction is submitted
    raw_data JSONB,  -- Store complete original JSON if needed, only for the block where the transaction is submitted
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(account_id, block_height, token_id), -- can be multiple token changes in the same block
    CHECK (block_timestamp > 0),
    CHECK (block_height > 0)
);

-- Indexes for common queries
CREATE INDEX idx_balance_changes_account ON balance_changes(account_id);
CREATE INDEX idx_balance_changes_block_height ON balance_changes(block_height DESC);
CREATE INDEX idx_balance_changes_timestamp ON balance_changes(block_timestamp DESC);
CREATE INDEX idx_balance_changes_tx_hashes ON balance_changes USING GIN(transaction_hashes);
CREATE INDEX idx_balance_changes_token_id ON balance_changes(token_id);
CREATE INDEX idx_balance_changes_counterparty ON balance_changes(counterparty);
CREATE INDEX idx_balance_changes_receipt_id ON balance_changes USING GIN(receipt_id);
```

#### Example Queries

**Get recent balance changes for an account**:
```sql
SELECT block_height, block_timestamp, token_id, amount, balance_after, counterparty
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
ORDER BY block_height DESC
LIMIT 10;
```

**Get NEAR balance at specific block**:
```sql
SELECT balance_after
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
  AND token_id = 'near'  -- 'near' for NEAR token
  AND block_height <= 152093047
ORDER BY block_height DESC
LIMIT 1;
```

**Get specific token balance at block**:
```sql
SELECT balance_after
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
  AND token_id = 'wrap.near'
  AND block_height <= 152093047
ORDER BY block_height DESC
LIMIT 1;
```

**Find all transfers from specific counterparty**:
```sql
SELECT block_height, block_timestamp, token_id, amount, counterparty
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
  AND counterparty = 'petersalomonsen.near'
ORDER BY block_height DESC;
```

**Get all token balance changes in a specific block**:
```sql
SELECT token_id, amount, balance_before, balance_after, counterparty
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
  AND block_height = 152093047
ORDER BY token_id;
```

**Get transaction details by hash**:
```sql
SELECT block_height, block_timestamp, token_id, amount, counterparty, actions
FROM balance_changes
WHERE account_id = 'treasury.sputnik-dao.near'
  AND '9xYL11LbmyVEoKpPnEmuH7Rb58XUK9rjL1t98fMjZb1i' = ANY(transaction_hashes)
ORDER BY block_height;
```

Migration structure:
```
nt-be/migrations/
  └── 20251223000001_create_balance_changes.sql
```

### 3. Connection Pool Setup

Add database connection pool to `AppState`:
```rust
pub struct AppState {
    pub http_client: reqwest::Client,
    pub cache: Cache<String, serde_json::Value>,
    pub network: NetworkConfig,
    pub archival_network: NetworkConfig,
    pub env_vars: EnvVars,
    pub db_pool: sqlx::PgPool,  // Add this
}
```

Configure connection pool in `lib.rs` (refactored from `main.rs`):
- Read `DATABASE_URL` from environment
- Set appropriate pool size (20 connections configured)
- Configure connection timeouts (3 second acquire timeout)
- Automatic migration execution on startup
- Logging initialization with env_logger

### 4. Local Development Setup

Create `nt-be/docker-compose.yml`:
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: treasury_dev
      POSTGRES_PASSWORD: dev_password
      POSTGRES_DB: treasury_db
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  postgres_test:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: treasury_test
      POSTGRES_PASSWORD: test_password
      POSTGRES_DB: treasury_test_db
    ports:
      - "5433:5432"

volumes:
  postgres_data:
```

Add `.env.example`:
```
DATABASE_URL=postgresql://treasury_dev:dev_password@localhost:5432/treasury_db
DATABASE_URL_TEST=postgresql://treasury_test:test_password@localhost:5433/treasury_test_db
```

### 5. Health Check Endpoint

Implement `/api/health` endpoint that:
- Checks database connectivity
- Returns database connection pool stats
- Includes timestamp and version info
- Returns 503 if database is unavailable

Response format:
```json
{
  "status": "healthy",
  "timestamp": "2023-12-23T10:00:00Z",
  "database": {
    "connected": true,
    "pool_size": 5,
    "idle_connections": 3
  }
}
```

### 6. Integration Tests

Created integration tests:
- `nt-be/tests/database_test.rs`: Tests health endpoint with real server process
- `nt-be/tests/balance_changes_test.rs`: Tests balance changes API end-to-end
  - Loads test data from JSON
  - Spawns actual server using `cargo run --bin nf-be`
  - Tests queries, filtering, pagination
  - Automatic cleanup via Drop trait

CI/CD considerations:
- GitHub Actions workflow in `.github/workflows/backend-tests.yml`
- PostgreSQL service container in CI
- Runs migrations, unit tests, integration tests
- Code quality checks: `cargo fmt --check` and `cargo clippy`

### 7. Error Handling

Implement proper error handling for:
- Connection failures (retry logic)
- Query timeouts
- Pool exhaustion
- Migration failures

### 7. Balance Changes API

Implemented REST API endpoint for querying balance changes:
- **Endpoint:** `GET /api/balance-changes`
- **Query Parameters:**
  - `account_id` (required): NEAR account to query
  - `token_id` (optional): Filter by specific token
  - `limit` (optional, default 100): Results per page
  - `offset` (optional, default 0): Pagination offset
- **Implementation:** `nt-be/src/routes/balance_changes.rs`
- Uses BigDecimal for NUMERIC field serialization
- Efficient queries with composite indexes

### 8. Data Loading Utilities

Created utilities for loading test/development data:
- `nt-be/src/bin/load_test_data.rs`: Loads JSON data into database
- `nt-be/src/bin/convert_test_data.rs`: Converts JSON to SQL INSERT statements
- Test data: 150 balance changes from real NEAR account

### 9. Documentation

Created comprehensive documentation:
- `nt-be/DATABASE.md`: Complete setup guide with troubleshooting
- `docs/implementation-plans/balance-changes-api-summary.md`: API implementation details
- Updated README with database setup instructions

## Acceptance Criteria

- ✅ Database dependencies added to Cargo.toml (sqlx, bigdecimal, uuid)
- ✅ Connection pool configured in AppState (lib.rs)
- ✅ Local Docker setup working (docker-compose.yml with dev + test databases)
- ✅ Health endpoint enhanced with database connectivity checks
- ✅ Integration tests passing locally and in CI (database_test.rs, balance_changes_test.rs)
- ✅ Database migrations working (automatic execution on startup)
- ✅ Balance changes API implemented with pagination and filtering
- ✅ Data loading utilities created (load_test_data, convert_test_data binaries)
- ✅ NUMERIC(78, 0) used for arbitrary precision yoctoNEAR amounts
- ✅ CI/CD workflow configured (.github/workflows/backend-tests.yml)
- ✅ Documentation complete (DATABASE.md, balance-changes-api-summary.md)

## Future Enhancements

- Connection pooling metrics
- Query performance monitoring
- Automated backups (Render.com provides this)
- Read replicas for scaling (if needed)
- Database indexing optimization

## Notes

- ✅ NUMERIC(78, 0) chosen over BIGINT because yoctoNEAR amounts (10^24) exceed BIGINT max (~9.2×10^18)
- ✅ BigDecimal used in Rust for NUMERIC field serialization with serde support
- ✅ Test binaries require `--bin` flag: `cargo run --bin nf-be` (multiple binaries in project)
- ✅ Render.yaml updated to use `cargo build --release --bin nf-be`
- ✅ Connection pool automatically handles cleanup via Drop trait
- ✅ sqlx uses prepared statements by default, preventing SQL injection
