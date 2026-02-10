#!/bin/bash
set -e

echo "=== Treasury26 DevContainer Post-Create Setup ==="

# Install Rust 1.86 toolchain for NEAR contract compilation
# (contracts require specific Rust version for reproducible builds)
echo "Installing Rust 1.86 toolchain..."
rustup toolchain install 1.86.0
rustup target add wasm32-unknown-unknown --toolchain 1.86.0

# Add wasm32 target to default toolchain as well
rustup target add wasm32-unknown-unknown

# Install cargo-near using the official installer
echo "Installing cargo-near..."
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh

# Install system dependencies
echo "Installing system dependencies..."
sudo apt update
sudo apt install -y pkg-config libudev-dev postgresql-client

# Install sqlx-cli for database migrations
echo "Installing sqlx-cli..."
cargo install sqlx-cli --no-default-features --features postgres

# Install Claude Code CLI
echo "Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Copy environment files if they don't exist
if [ ! -f nt-be/.env ]; then
    echo "Creating nt-be/.env from example..."
    cp nt-be/.env.example nt-be/.env
fi

if [ ! -f nt-be/.env.test ]; then
    echo "nt-be/.env.test already exists"
fi

echo "=== Post-Create Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Run: bash .devcontainer/post-start.sh  (starts database)"
echo "2. Run: cd nt-be && cargo test  (run tests)"
echo "3. Run: claude  (start Claude Code agent)"
