# Treasury26 Frontend

Next.js frontend for Treasury26 - a cross-chain multisig security platform for managing digital assets on NEAR Protocol.

## Features

- 🔐 **Ledger Hardware Wallet Support** - Secure authentication with Ledger Nano X/S/Flex
- 💼 **Treasury Management** - Multi-signature wallet management
- 💸 **Payment Requests** - Create and approve payment proposals
- 📊 **Dashboard** - Overview of treasury assets and activity

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js 18+
- For Ledger support: Chrome/Edge browser with WebHID API support

### Installation

```bash
bun install
```

### Development

#### Option 1: Using Production Backend (Recommended for Testing)

When developing locally but connecting to the production backend (https://api.trezu.app), you need to use the CORS proxy to avoid cross-origin issues:

1. **Start the proxy server** (in one terminal):
   ```bash
   bun run proxy
   ```
   This starts a CORS proxy on `http://localhost:8888` that forwards requests to the production backend.

2. **Start the dev server** (in another terminal):
   ```bash
   NEXT_PUBLIC_BACKEND_API_BASE=http://localhost:8888 bun run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000)

#### Option 2: Using Local Backend

If you have the backend running locally:

```bash
NEXT_PUBLIC_BACKEND_API_BASE=http://localhost:8080 bun run dev
```

### CORS Proxy Server

The `proxy-server.js` provides a simple HTTP proxy that:
- Forwards API requests from `localhost:8888` to the production backend
- Handles CORS headers automatically
- Logs all proxied requests for debugging

**Environment Variables:**
- `PROXY_PORT` - Port for the proxy server (default: 8888)
- `BACKEND_PROXY_TARGET` - Target backend URL (default: https://api.trezu.app)

**Example:**
```bash
PROXY_PORT=9000 BACKEND_PROXY_TARGET=https://api.trezu.app bun run proxy
```

## Scripts

- `bun run dev` - Start development server
- `bun run dev:ledger` - Watch and rebuild Ledger wallet on changes
- `bun run build` - Build for production (includes Ledger wallet)
- `bun run build:ledger` - Build Ledger wallet only
- `bun run start` - Start production server
- `bun run proxy` - Start CORS proxy server
- `bun run lint` - Run Biome linter
- `bun run format` - Format code with Biome
- `bun run test:e2e` - Run Playwright E2E tests
- `bun run test:e2e:ui` - Run E2E tests with UI

## Ledger Support

This application supports Ledger hardware wallets (Nano X, Nano S, Nano S Plus, Flex) for secure authentication using NEP-413 message signing.

### Requirements

- **Browser:** Chrome, Edge, or any Chromium-based browser with WebHID support
- **Ledger App:** NEAR app v2.4.3+ installed via Ledger Live
- **Ledger Device:** Unlocked with NEAR app open during sign-in

### Implementation Details

The Ledger integration uses:
- WebHID/WebUSB/WebBLE API for device communication
- NEP-413 message signing standard
- NEP-366 delegate actions (meta-transactions)
- Borsh serialization for payload formatting
- Base64 encoding for signatures

## Project Structure

```
nt-fe/
├── app/                    # Next.js app directory
│   ├── (init)/            # Onboarding and authentication flows
│   ├── (treasury)/        # Main treasury application
│   └── api/               # API routes (if any)
├── components/            # Reusable UI components
├── features/              # Feature-specific components and logic
├── hooks/                 # Custom React hooks
├── lib/                   # Utility functions and API clients
├── stores/                # Zustand state management
├── types/                 # TypeScript type definitions
└── proxy-server.js        # Development CORS proxy

```

## Environment Variables

- `NEXT_PUBLIC_BACKEND_API_BASE` - Backend API base URL (default: http://localhost:8080)
- `NEXT_PUBLIC_GTM_ID` - Google Tag Manager container ID (for example: GTM-XXXXXXX). Marketing configures GA4 and conversion tags inside GTM.

## Tech Stack

- **Framework:** Next.js 16 with App Router
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **State Management:** Zustand
- **Data Fetching:** TanStack Query
- **Wallet Integration:** @hot-labs/near-connect
- **Hardware Wallet:** Ledger WebHID
- **Package Manager:** Bun

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [NEAR Protocol](https://near.org)
- [NEP-413 Standard](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
- [Ledger Developer Docs](https://developers.ledger.com/)
