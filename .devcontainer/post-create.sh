#!/bin/bash

# Install Rust 1.86 toolchain for NEAR contract compilation
# (contracts require specific Rust version for reproducible builds)
rustup toolchain install 1.86.0
rustup target add wasm32-unknown-unknown --toolchain 1.86.0

# Add wasm32 target to default toolchain as well
rustup target add wasm32-unknown-unknown

# Install cargo-near using the official installer
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh

sudo apt update
sudo apt install -y pkg-config libudev-dev
