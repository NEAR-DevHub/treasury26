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
sqlx = { version = "0.8", features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "chrono", "json"] }
uuid = { version = "1.0", features = ["v4", "serde"] }
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
    amount BIGINT NOT NULL, -- positive for ingoing amounts, negative for outgoing
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    
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

**Optional: `sync_status`** - Track sync progress per account
```sql
CREATE TABLE sync_status (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL UNIQUE,
    
    last_synced_block BIGINT NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    first_block BIGINT,  -- First block with data
    total_changes INTEGER DEFAULT 0,
    
    sync_errors JSONB,  -- Track any sync issues
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
  AND token_id IS NULL  -- NULL means NEAR token
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
  ├── 20251223000001_create_balance_changes.sql
  └── 20251223000002_create_sync_status.sql
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

Configure connection pool in `main.rs`:
- Read `DATABASE_URL` from environment
- Set appropriate pool size (max 10-20 connections for Render free tier)
- Configure connection timeouts
- Add graceful shutdown handling

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

Create `nt-be/tests/database_test.rs`:
- Test database connection establishment
- Test health endpoint returns 200 when DB is up
- Test health endpoint returns 503 when DB is down
- Test basic CRUD operations (once schema is defined)

CI/CD considerations:
- Use `postgres_test` service in GitHub Actions
- Run migrations before tests
- Clean up test data after each test

### 7. Error Handling

Implement proper error handling for:
- Connection failures (retry logic)
- Query timeouts
- Pool exhaustion
- Migration failures

### 8. Documentation

Update README with:
- How to start local database
- How to run migrations
- How to run integration tests
- Database connection troubleshooting

## Acceptance Criteria

- ✅ Database dependencies added to Cargo.toml
- ✅ Connection pool configured in AppState
- ✅ Local Docker setup working
- ✅ Health endpoint implemented and tested
- ✅ Integration tests passing locally and in CI
- ✅ Database migrations working
- ✅ Production deployment successful with database connection
- ✅ Documentation complete

## Future Enhancements

- Connection pooling metrics
- Query performance monitoring
- Automated backups (Render.com provides this)
- Read replicas for scaling (if needed)
- Database indexing optimization

## Notes

- Start with minimal schema - iterate based on features needed
- Consider using database for caching instead of in-memory for horizontal scaling
- Ensure proper connection cleanup on shutdown
- Use prepared statements to prevent SQL injection
