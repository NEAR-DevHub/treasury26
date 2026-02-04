# PingPay Subscription Payment Integration Plan

## Summary

Integrate [PingPay](https://pingpay.io) for treasury subscription payments, allowing users to pay in any token while Trezu receives USDC. This enables a monetization path for Trezu through upfront subscription payments (3, 6, or 12 months).

## Motivation

Trezu needs a sustainable revenue model. PingPay, powered by NEAR Intents, provides:
- **Pay in any token** - Users pay with whatever tokens they have
- **Receive in USDC** - Trezu always receives stable USDC
- **No custody risk** - Payments flow directly through the protocol
- **Cross-chain support** - Users can pay from multiple chains

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         Settings > Subscription Tab                      │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │   │
│  │  │ Plan     │  │ Subscribe│  │ Payment History      │  │   │
│  │  │ Selector │  │ Button   │  │ + Invoice Download   │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Rust/Axum)                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              /api/subscriptions/*                         │  │
│  │  ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────────────┐│  │
│  │  │ plans  │ │ status │ │ checkout │ │ callback         ││  │
│  │  │ GET    │ │ GET    │ │ POST     │ │ GET (redirect)   ││  │
│  │  └────────┘ └────────┘ └──────────┘ └──────────────────┘│  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    PingPay Client                         │  │
│  │  POST /api/checkout/sessions → sessionUrl                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PingPay (External)                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  https://pay.pingpay.io                                   │  │
│  │  - Checkout UI (user pays in any token)                   │  │
│  │  - NEAR Intents (token conversion)                        │  │
│  │  - Redirect to success/cancel URL with payment status     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## PingPay API (Verified)

**Reference:** [ping-checkout-example](https://github.com/Pingpayio/ping-checkout-example)
**Dashboard:** [pay.pingpay.io/dashboard](https://pay.pingpay.io/dashboard)

### Create Checkout Session

```
POST https://pay.pingpay.io/api/checkout/sessions
Headers: x-api-key: <api_key>
```

**Request:**
```json
{
  "amount": "150000000",
  "asset": { "chain": "NEAR", "symbol": "USDC" },
  "successUrl": "https://backend.trezu.app/api/subscriptions/callback?type=success&subscription_id=1&internal_payment_id=1",
  "cancelUrl": "https://backend.trezu.app/api/subscriptions/callback?type=cancel&subscription_id=1&internal_payment_id=1",
  "metadata": {
    "treasury_id": "my-dao.sputnik-dao.near",
    "plan_id": "12m",
    "subscription_id": "1",
    "payment_id": "1"
  }
}
```

**Response (actual from API):**
```json
{
  "session": {
    "sessionId": "cs_ZzHUU6qf_7NgK4_rC66MI",
    "status": "CREATED",
    "paymentId": null,
    "amount": {
      "assetId": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "amount": "50000000",
      "decimals": 6
    },
    "recipient": {
      "address": "webassemblymusic-treasury.sputnik-dao.near"
    },
    "successUrl": "...",
    "cancelUrl": "...",
    "createdAt": "2026-02-02T19:10:10.447Z",
    "expiresAt": "2026-02-02T20:10:10.448Z"
  },
  "sessionUrl": "https://pay.pingpay.io/checkout?sessionId=cs_ZzHUU6qf_7NgK4_rC66MI"
}
```

> **Note:** The response `amount` is an object (not a string) and `recipient` is an object with `address` (not a flat string). The response structs in `pingpay.rs` have been updated to match.

### Callback URL Parameters

On payment completion, PingPay redirects user to the success/cancel URL with additional query params:
- `paymentId` - PingPay payment ID
- `sessionId` - Original session ID
- `txStatus` - `SUCCESS` | `FAILED` | `REFUNDED`
- `depositAddress` - Transaction reference

Our callback URLs also include `subscription_id` and `internal_payment_id` for internal tracking.

### Payment Flow (Redirect-based)

```
1. User clicks "Subscribe" → selects plan (3m/6m/12m)
                    │
                    ▼
2. Frontend POST /api/subscriptions/checkout
   { accountId: "dao.sputnik-dao.near", planId: "12m" }
                    │
                    ▼
3. Backend:
   - Creates treasury_subscriptions (status: pending)
   - Creates subscription_payments (status: pending)
   - Calls PingPay API → gets sessionUrl
   - Returns { sessionUrl, sessionId, subscriptionId, paymentId }
                    │
                    ▼
4. Frontend redirects user to PingPay checkout (sessionUrl)
                    │
                    ▼
5. User pays (any token → USDC via NEAR Intents)
                    │
                    ▼
6. PingPay redirects to BACKEND callback:
   /api/subscriptions/callback?type=success&sessionId=...&paymentId=...&txStatus=SUCCESS
                    │
                    ▼
7. Backend callback handler:
   - Finds payment by sessionId or internal_payment_id
   - Updates payment record (status: completed, pingpay_payment_id, etc.)
   - Activates subscription (status: active, starts_at, expires_at)
   - Redirects to FRONTEND success page
                    │
                    ▼
8. Frontend shows "Subscription Active!"
```

> **Important:** PingPay success/cancel URLs point to the **backend** callback handler (`BACKEND_URL/api/subscriptions/callback`). The backend then redirects to the **frontend** success/cancel pages (`SUBSCRIPTION_SUCCESS_URL` / `SUBSCRIPTION_CANCEL_URL`).

## Database Schema

```sql
-- Subscription plans (configurable pricing)
CREATE TABLE subscription_plans (
    id VARCHAR(16) PRIMARY KEY,        -- '3m', '6m', '12m'
    name VARCHAR(64) NOT NULL,
    duration_months INTEGER NOT NULL,
    price_usdc NUMERIC(18, 6) NOT NULL,
    active BOOLEAN DEFAULT true
);

-- Treasury subscriptions
CREATE TABLE treasury_subscriptions (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(128) NOT NULL,  -- Treasury account
    plan_id VARCHAR(16) REFERENCES subscription_plans(id),
    status VARCHAR(16) NOT NULL,       -- pending, active, expired, cancelled
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment records
CREATE TABLE subscription_payments (
    id SERIAL PRIMARY KEY,
    subscription_id INTEGER REFERENCES treasury_subscriptions(id),
    usdc_amount NUMERIC(18, 6) NOT NULL,
    pingpay_session_id VARCHAR(128),
    pingpay_payment_id VARCHAR(128),
    deposit_address VARCHAR(256),
    tx_status VARCHAR(32),
    status VARCHAR(16) NOT NULL,       -- pending, completed, failed, expired
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Invoice records (future)
CREATE TABLE subscription_invoices (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER REFERENCES subscription_payments(id),
    invoice_number VARCHAR(32) UNIQUE,
    invoice_data JSONB NOT NULL
);
```

Default plans seeded:
| Plan | Duration | Price |
|------|----------|-------|
| 3m   | 3 months | $50 USDC |
| 6m   | 6 months | $90 USDC |
| 12m  | 12 months | $150 USDC |

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/subscriptions/plans` | GET | List available subscription plans |
| `/api/subscriptions/status?account_id=...` | GET | Get treasury subscription status |
| `/api/subscriptions/checkout` | POST | Create PingPay checkout session |
| `/api/subscriptions/callback` | GET | Handle PingPay redirect |
| `/api/subscriptions/invoice/:payment_id` | GET | Download invoice (future) |

### Response Examples

**GET /api/subscriptions/plans**
```json
{
  "plans": [
    { "id": "3m", "name": "3 Month Subscription", "durationMonths": 3, "priceUsdc": "50.00" },
    { "id": "6m", "name": "6 Month Subscription", "durationMonths": 6, "priceUsdc": "90.00" },
    { "id": "12m", "name": "12 Month Subscription", "durationMonths": 12, "priceUsdc": "150.00" }
  ]
}
```

**GET /api/subscriptions/status?account_id=test.sputnik-dao.near** (active)
```json
{
  "isActive": true,
  "subscription": {
    "id": 5,
    "planId": "3m",
    "planName": "3 Month Subscription",
    "status": "active",
    "startsAt": "2026-02-04T06:47:08.654909Z",
    "expiresAt": "2026-05-05T06:47:08.654909Z",
    "daysRemaining": 89
  },
  "payments": [
    {
      "id": 5,
      "usdcAmount": "50.00",
      "status": "completed",
      "createdAt": "2026-02-04T06:47:02.960766Z",
      "completedAt": "2026-02-04T06:47:08.680217Z",
      "hasInvoice": false
    }
  ]
}
```

**POST /api/subscriptions/checkout** `{ "accountId": "...", "planId": "3m" }`
```json
{
  "sessionUrl": "https://pay.pingpay.io/checkout?sessionId=cs_ZElSmlcdZZKTaLCyohcSr",
  "sessionId": "cs_ZElSmlcdZZKTaLCyohcSr",
  "subscriptionId": 5,
  "paymentId": 5
}
```

## Environment Variables

```bash
# Backend public URL (for PingPay callback redirects)
BACKEND_URL=https://backend.trezu.app  # default: http://localhost:3002

# PingPay configuration
PINGPAY_API_URL=https://pay.pingpay.io/api
PINGPAY_API_KEY=<from PingPay dashboard>
PINGPAY_MOCK_MODE=false  # true for sandbox testing

# Frontend redirect URLs (where backend sends user after processing callback)
SUBSCRIPTION_SUCCESS_URL=https://trezu.app/subscription/success
SUBSCRIPTION_CANCEL_URL=https://trezu.app/subscription/cancel
```

## Sandbox Testing

PingPay uses redirect-based confirmation (no webhooks). For sandbox/docker testing:

**Mock PingPay Service** (when `PINGPAY_MOCK_MODE=true`):
1. Mock endpoint returns fake sessionUrl pointing to local mock checkout
2. Mock checkout page has "Simulate Payment" button
3. Button redirects to callback URL with success params

This allows full flow testing without real payments.

## Implementation Status

### Completed

- [x] Database migration (`nt-be/migrations/20260201000002_create_subscriptions.sql`)
- [x] Environment variables (`nt-be/src/utils/env.rs` - `BACKEND_URL`, `PINGPAY_API_URL`, `PINGPAY_API_KEY`, `PINGPAY_MOCK_MODE`, `SUBSCRIPTION_SUCCESS_URL`, `SUBSCRIPTION_CANCEL_URL`)
- [x] PingPay client module (`nt-be/src/handlers/subscriptions/pingpay.rs`)
- [x] Backend endpoints:
  - [x] GET `/api/subscriptions/plans` (`plans.rs`)
  - [x] GET `/api/subscriptions/status` (`status.rs`)
  - [x] POST `/api/subscriptions/checkout` (`checkout.rs`)
  - [x] GET `/api/subscriptions/callback` (`callback.rs`)
- [x] Routes configured (`nt-be/src/routes/mod.rs`)
- [x] Tested against real PingPay API (checkout session creation + callback flow verified)

### Remaining Work

- [ ] **Mock PingPay service for sandbox** - When `PINGPAY_MOCK_MODE=true`, intercept PingPay calls with local mock that simulates the checkout + redirect flow
- [ ] **Frontend subscription tab** (see details below)
- [ ] **Invoice generation** - Store invoice data as JSONB, generate PDF on demand
- [ ] **Tests** - Unit tests for PingPay client, integration tests for checkout flow

## Remaining: Frontend Subscription Tab

### Files to Create

```
nt-fe/
├── app/(treasury)/[treasuryId]/settings/
│   └── components/
│       └── subscription-tab.tsx        # New settings tab
├── app/subscription/
│   ├── success/page.tsx                # Success redirect page
│   └── cancel/page.tsx                 # Cancel redirect page
└── lib/
    └── subscription-api.ts             # API client functions
```

### Files to Modify

```
nt-fe/app/(treasury)/[treasuryId]/settings/page.tsx
  - Add { value: "subscription", label: "Subscription" } to tabs array
  - Import and render <SubscriptionTab /> for activeTab === "subscription"
```

### Frontend Patterns to Follow

The settings page uses a tab-based architecture. Existing tabs (general, voting, preferences) provide patterns:

- **State management:** `useState` for active tab, React Query for data fetching
- **Components:** `PageCard` for sections, `TabGroup` for tab switching
- **API calls:** `axios.get/post` from `lib/api.ts` with `NEXT_PUBLIC_BACKEND_API_BASE`
- **Notifications:** `toast` from `sonner`
- **Stores:** `useTreasury()` for `selectedTreasury`, `useNear()` for `accountId`

### subscription-api.ts

```typescript
import axios from "axios";

const API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE;

export interface Plan {
  id: string;
  name: string;
  durationMonths: number;
  priceUsdc: string;
}

export interface SubscriptionStatus {
  isActive: boolean;
  subscription?: {
    id: number;
    planId: string;
    planName: string;
    status: string;
    startsAt: string;
    expiresAt: string;
    daysRemaining: number;
  };
  payments: {
    id: number;
    usdcAmount: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    hasInvoice: boolean;
  }[];
}

export interface CheckoutResponse {
  sessionUrl: string;
  sessionId: string;
  subscriptionId: number;
  paymentId: number;
}

export async function getSubscriptionPlans(): Promise<Plan[]> {
  const { data } = await axios.get(`${API_BASE}/api/subscriptions/plans`);
  return data.plans;
}

export async function getSubscriptionStatus(accountId: string): Promise<SubscriptionStatus> {
  const { data } = await axios.get(`${API_BASE}/api/subscriptions/status`, {
    params: { account_id: accountId },
  });
  return data;
}

export async function createCheckout(accountId: string, planId: string): Promise<CheckoutResponse> {
  const { data } = await axios.post(`${API_BASE}/api/subscriptions/checkout`, {
    accountId,
    planId,
  });
  return data;
}
```

### subscription-tab.tsx Outline

```tsx
"use client";

// Components:
// 1. SubscriptionStatus - Shows current status (Active until X / No subscription)
// 2. PlanCards - Shows available plans with pricing, highlight current plan
// 3. SubscribeButton - Calls checkout API, redirects to PingPay
// 4. PaymentHistory - Table of past payments with status

// Flow:
// - Fetch plans via getSubscriptionPlans()
// - Fetch status via getSubscriptionStatus(selectedTreasury)
// - On "Subscribe" click: createCheckout(selectedTreasury, planId)
// - Redirect to response.sessionUrl (window.location.href)
// - User pays on PingPay → redirected to backend callback → frontend success page
```

### Success/Cancel Pages

**`app/subscription/success/page.tsx`:**
- Read `subscription_id` and `payment_id` from URL search params
- Show success message with subscription details
- Link back to treasury settings

**`app/subscription/cancel/page.tsx`:**
- Read `error` and `cancelled` from URL search params
- Show appropriate message (cancelled vs. failed)
- Link to retry or go back to settings

## Remaining: Mock PingPay Service

When `PINGPAY_MOCK_MODE=true` in the backend:

1. The `PingPayClient` should return a mock response with a `sessionUrl` pointing to a local HTML page
2. The mock page shows plan details and a "Simulate Payment" button
3. The button redirects to the callback URL with `txStatus=SUCCESS`

This could be a simple static HTML page served by the backend, or an endpoint that returns HTML.

## Remaining: Invoice Generation

1. On successful payment, create `subscription_invoices` record with JSONB data
2. Invoice data includes: invoice number, date, treasury info, plan info, payment details, period
3. Endpoint `GET /api/subscriptions/invoice/:payment_id` generates and returns a PDF
4. Consider `genpdf` crate for server-side PDF, or return JSON and generate PDF on frontend

## Future Enhancements

1. **Recurring Subscriptions** - When PingPay adds subscription support (planned with Outlayer + TEE)
2. **Multiple Payment Methods** - Cards, other crypto
3. **Tiered Features** - Different feature sets per plan
4. **Usage-Based Billing** - Pay per export, per transaction, etc.

## References

- [PingPay](https://pingpay.io)
- [PingPay Checkout Example](https://github.com/Pingpayio/ping-checkout-example)
- [PingPay Dashboard](https://pay.pingpay.io/dashboard)
- [NEAR Intents](https://docs.near-intents.org)
- [GitHub Issue #120](https://github.com/NEAR-DevHub/treasury26/issues/120)
