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

## PingPay API

**Reference:** [ping-checkout-example](https://github.com/Pingpayio/ping-checkout-example)

### Create Checkout Session

```
POST https://pay.pingpay.io/api/checkout/sessions
Headers: x-api-key: <api_key>
```

**Request:**
```json
{
  "amount": "150000000",        // 150 USDC (6 decimals)
  "asset": { "chain": "NEAR", "symbol": "USDC" },
  "successUrl": "https://trezu.app/api/subscriptions/callback?type=success",
  "cancelUrl": "https://trezu.app/api/subscriptions/callback?type=cancel",
  "metadata": {
    "treasury_id": "my-dao.sputnik-dao.near",
    "plan_id": "12m",
    "subscription_id": "123"
  }
}
```

**Response:**
```json
{
  "session": {
    "sessionId": "sess_xxx",
    "status": "pending",
    "amount": "150000000",
    "recipient": "trezu.near",
    "asset": { "chain": "NEAR", "symbol": "USDC" },
    "expiresAt": "2026-02-01T13:00:00Z"
  },
  "sessionUrl": "https://pay.pingpay.io/checkout?sessionId=sess_xxx"
}
```

### Callback URL Parameters

On payment completion, user is redirected with:
- `paymentId` - PingPay payment ID
- `sessionId` - Original session ID
- `txStatus` - `SUCCESS` | `FAILED` | `REFUNDED`
- `depositAddress` - Transaction reference

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
    created_at TIMESTAMPTZ DEFAULT NOW()
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

-- Invoice records
CREATE TABLE subscription_invoices (
    id SERIAL PRIMARY KEY,
    payment_id INTEGER REFERENCES subscription_payments(id),
    invoice_number VARCHAR(32) UNIQUE,
    invoice_data JSONB NOT NULL
);
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/subscriptions/plans` | GET | List available subscription plans |
| `/api/subscriptions/status?account_id=...` | GET | Get treasury subscription status |
| `/api/subscriptions/checkout` | POST | Create PingPay checkout session |
| `/api/subscriptions/callback` | GET | Handle PingPay redirect |
| `/api/subscriptions/invoice/:payment_id` | GET | Download invoice (future) |

## Payment Flow

```
1. User clicks "Subscribe" → selects plan (3m/6m/12m)
                    │
                    ▼
2. Frontend POST /api/subscriptions/checkout
   { account_id: "dao.sputnik-dao.near", plan_id: "12m" }
                    │
                    ▼
3. Backend:
   - Creates treasury_subscriptions (status: pending)
   - Creates subscription_payments (status: pending)
   - Calls PingPay API → gets sessionUrl
   - Returns sessionUrl to frontend
                    │
                    ▼
4. Frontend redirects user to PingPay checkout
                    │
                    ▼
5. User pays (any token → USDC via NEAR Intents)
                    │
                    ▼
6. PingPay redirects to /api/subscriptions/callback
   ?sessionId=...&paymentId=...&txStatus=SUCCESS
                    │
                    ▼
7. Backend callback handler:
   - Updates payment record (status: completed)
   - Activates subscription (status: active, expires_at)
   - Redirects to frontend success page
                    │
                    ▼
8. Frontend shows "Subscription Active!"
```

## Environment Variables

```bash
# PingPay configuration
PINGPAY_API_URL=https://pay.pingpay.io
PINGPAY_API_KEY=pk_...
PINGPAY_MOCK_MODE=false  # true for sandbox testing

# Callback URLs
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

- [x] Database migration
- [x] Environment variables
- [x] PingPay client module
- [x] Backend endpoints (plans, status, checkout, callback)
- [x] Routes configured
- [ ] Mock PingPay service for sandbox
- [ ] Frontend subscription tab
- [ ] Invoice generation
- [ ] Tests

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
