# E2E Tests for Treasury26 Frontend

This directory contains Playwright end-to-end tests for the Treasury26 frontend application.

## Setup

```bash
# Install dependencies (from nt-fe directory)
npm install

# Install Playwright browsers
npx playwright install chromium
```

## Running Tests

### Local Development

```bash
# Run all tests (starts dev server automatically)
npm run test:e2e

# Run tests with UI mode (interactive)
npm run test:e2e:ui

# Run tests in headed mode (see browser)
npm run test:e2e:headed
```

### With Docker Sandbox Backend

The tests can run against the full sandbox environment which includes:
- NEAR Sandbox blockchain
- Treasury Backend API
- Sputnik DAO Indexer

```bash
# Using Docker Compose
npm run test:e2e:docker
```

Or manually:

```bash
# 1. Start the sandbox
docker run -d --name sandbox \
  -p 3030:3030 -p 8080:8080 -p 5001:5001 \
  ghcr.io/near-devhub/treasury26/near-treasury-sandbox:main

# 2. Wait for it to be ready
curl http://localhost:8080/api/health

# 3. Run tests with backend URL
BACKEND_URL=http://localhost:8080 npm run test:e2e

# 4. Cleanup
docker rm -f sandbox
```

## Test Structure

```
e2e/
├── README.md             # This documentation
└── ledger-login.spec.ts  # Ledger wallet login flow tests
```

## Ledger Testing

The Ledger login test verifies the UI flow for connecting a Ledger hardware wallet:

1. Navigates to `/app`
2. Clicks the "Connect Wallet" button
3. Verifies the wallet selector modal appears
4. Clicks on the Ledger option to initiate the flow

### Limitations

Due to hardware requirements and the sandboxed iframe architecture:
- Full end-to-end Ledger flow requires actual hardware device
- WebHID API cannot be fully tested without real USB device
- Current tests verify the UI flow up to the point of device connection

### Future Improvements

- Add WebHID mocking for more complete flow testing
- Add iframe communication testing for Ledger executor
- Add visual regression tests for Ledger dialogs

## CI/CD

Tests run automatically on:
- Push to `main` branch
- Pull requests targeting `main`

See `.github/workflows/frontend-e2e.yml` for the workflow configuration.
