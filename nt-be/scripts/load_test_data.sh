#!/bin/bash
set -e

echo "Loading test data into development database..."

# Run the balance_changes test which loads the data
cd "$(dirname "$0")/.."

# Set DATABASE_URL to dev database
export DATABASE_URL="postgresql://treasury_dev:dev_password@localhost:5432/treasury_dev_db"

# Run a modified version that loads into dev DB
cargo run --bin load_test_data

echo "Test data loaded successfully!"
