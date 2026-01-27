# Treasury26

A comprehensive treasury management platform for NEAR DAOs. Manage members, process payments, create vesting schedules, track balances, and handle multi-signature approvals through Sputnik DAO integration.

## Project Structure

| Directory | Description | Documentation |
|-----------|-------------|---------------|
| [nt-be](./nt-be/) | Backend API (Rust/Axum) - Balance tracking, monitoring, CSV export | [README](./nt-be/README.md) |
| [nt-fe](./nt-fe/) | Frontend (Next.js) - Web interface for treasury management | [README](./nt-fe/README.md) |
| [contracts](./contracts/) | NEAR smart contracts for bulk payments | [README](./contracts/README.md) |
| [sandbox](./sandbox/) | Local development environment with Docker | [README](./sandbox/README.md) |
| [e2e-tests](./e2e-tests/) | End-to-end tests for contract integration | [README](./e2e-tests/bulk-payment/README.md) |

## Quick Links

- **Production Backend**: https://near-treasury-backend.onrender.com
- **Add Account for Tracking**: See [nt-be/README.md](./nt-be/README.md#1-register-an-account-for-monitoring)

## Features

### Treasury Management
- Create and configure treasuries with custom policies
- Member management with role-based permissions (proposer, approver, financial member)
- Dashboard with total balance overview and USD valuations

### Financial Operations
- Single and bulk payments in NEAR, NEP-141 tokens, and cross-chain via Intents
- Token vesting schedules with cliff dates and configurable release
- Automatic balance tracking and historical charts
- CSV export of transaction history

### DAO Integration
- Sputnik DAO proposal creation and management
- Multi-signature approval workflows
- Proposal filtering by status, token type, date, and participants

### Balance Monitoring
- Register accounts for automatic balance tracking
- Real-time balance change detection across multiple token types
- Staking rewards tracking
- Historical balance data with gap-filling

### Smart Contracts
- Bulk payment processing (up to 100 payments per batch)
- Storage credit system for batch operations
- Content-addressed payment lists (SHA-256)
- Support for NEAR, fungible tokens, and NEAR Intents

## Development

See individual README files for setup instructions:

- Backend: [nt-be/README.md](./nt-be/README.md)
- Frontend: [nt-fe/README.md](./nt-fe/README.md)
- Contracts: [contracts/README.md](./contracts/README.md)
- Local sandbox: [sandbox/README.md](./sandbox/README.md)
