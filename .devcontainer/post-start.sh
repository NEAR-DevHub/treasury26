#!/bin/bash
set -e

echo "=== Treasury26 DevContainer Post-Start Setup ==="

# Wait for Docker to be ready
echo "Waiting for Docker..."
while ! docker info > /dev/null 2>&1; do
    sleep 1
done
echo "Docker is ready!"

# Start the test database
echo "Starting PostgreSQL test database..."
cd /workspaces/treasury26/nt-be
docker compose up -d postgres_test

# Wait for database to be healthy
echo "Waiting for database to be healthy..."
until docker compose exec -T postgres_test pg_isready -U treasury_test -d treasury_test_db > /dev/null 2>&1; do
    echo "  Waiting for postgres_test..."
    sleep 2
done
echo "Database is ready!"

# Run migrations
echo "Running database migrations..."
export DATABASE_URL="postgresql://treasury_test:test_password@localhost:5433/treasury_test_db"
sqlx migrate run

echo ""
echo "=== Post-Start Setup Complete ==="
echo ""
echo "Database is running on port 5433"
echo "DATABASE_URL=$DATABASE_URL"
echo ""
echo "You can now run:"
echo "  cd nt-be && cargo test"
echo "  claude"
