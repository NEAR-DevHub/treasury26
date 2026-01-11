# Treasury Smart Contracts

This directory contains NEAR smart contracts for the Treasury application.

## Contracts

### bulk-payment

A contract for batch payment processing with support for:
- Native NEAR tokens
- NEP-141 fungible tokens
- NEAR Intents (multi-token)

See [bulk-payment/README.md](./bulk-payment/README.md) for details.

## Building Contracts

### Prerequisites

- Rust 1.86+ with `wasm32-unknown-unknown` target
- cargo-near (optional, for reproducible builds)

### Build Commands

```bash
# Build all contracts
cd contracts/bulk-payment
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test
```

### Artifacts

Built WASM files are located at:
```
target/wasm32-unknown-unknown/release/<contract_name>.wasm
```

## Deployment

### Testnet

```bash
near deploy <account-id> ./target/wasm32-unknown-unknown/release/bulk_payment_contract.wasm \
  --networkId testnet
```

### Mainnet

```bash
near deploy <account-id> ./target/wasm32-unknown-unknown/release/bulk_payment_contract.wasm \
  --networkId mainnet
```

## Contract Documentation

Each contract directory contains its own README with:
- API documentation
- Usage examples
- Configuration options
