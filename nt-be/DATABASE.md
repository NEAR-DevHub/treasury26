# NEAR Treasury Backend - Database Setup

## Prerequisites

Make sure Docker is running. If using Colima on macOS:

```bash
colima start
```

## Quick Start

### 1. Start the Database

```bash
cd nt-be
docker compose up -d postgres
```

This will start a PostgreSQL 16 container on port 5432.

To stop the database:

```bash
docker compose down
```

### 2. Set Up Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and update the values as needed. The default `DATABASE_URL` should work with the Docker setup:

```
DATABASE_URL=postgresql://treasury_dev:dev_password@localhost:5432/treasury_db
```

### 3. Run the Application

The application will automatically:
- Connect to the database
- Run migrations on startup
- Create the required tables

```bash
cargo run
```

### 4. Test the Database Connection

Check the health endpoint:

```bash
curl http://localhost:3002/api/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2023-12-23T10:00:00Z",
  "database": {
    "connected": true,
    "pool_size": 20,
    "idle_connections": 19
  }
}
```

## Database Management

### Install sqlx-cli

For manual migration management:

```bash
cargo install sqlx-cli --no-default-features --features postgres
```

### Run Migrations Manually

```bash
cd nt-be
sqlx migrate run --database-url "postgresql://treasury_dev:dev_password@localhost:5432/treasury_db"
```

### Create a New Migration

```bash
sqlx migrate add <migration_name>
```

### Revert Last Migration

```bash
sqlx migrate revert --database-url "postgresql://treasury_dev:dev_password@localhost:5432/treasury_db"
```

### Connect to Database

```bash
docker exec -it nt-be-postgres-1 psql -U treasury_dev -d treasury_db
```

Useful commands once connected:
```sql
\dt              -- List tables
\d balance_changes -- Describe table structure
SELECT * FROM balance_changes LIMIT 5;
```

## Database Schema

### balance_changes
Main table storing account balance history:
- One row per token change per block
- Tracks before/after balances
- Includes transaction metadata and counterparty info

## Troubleshooting

### Port Already in Use

If port 5432 is already in use:

```bash
docker-compose down
# Edit docker-compose.yml to use a different port, e.g., "5433:5432"
docker-compose up -d postgres
# Update DATABASE_URL in .env to match the new port
```

### Connection Refused

Make sure the database container is running:

```bash
docker-compose ps
docker-compose logs postgres
```

### Migration Errors

If migrations fail, you may need to reset the database:

```bash
docker-compose down -v  # This will delete all data!
docker-compose up -d postgres
cargo run  # Migrations will run automatically
```

## Testing

### Run Tests with Test Database

```bash
# Start test database
docker-compose up -d postgres_test

# Set test database URL
export DATABASE_URL_TEST=postgresql://treasury_test:test_password@localhost:5433/treasury_test_db

# Run tests
cargo test
```

## Production

The application is configured to use the `DATABASE_URL` environment variable provided by Render.com automatically. No additional configuration needed.
