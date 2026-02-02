# AI Guide: Subscription & Payment System

This document provides context for AI assistants working on Treasury26's subscription system.

## Quick Reference

| Plan       | Volume Limit | Overage | Exchange | Export/Batch Credits |
|------------|--------------|---------|----------|----------------------|
| Free       | $25k/mo      | 0.20%   | 0.35%    | 3/3 (one-time trial) |
| Plus       | $500k/mo     | 0.20%   | 0.20%    | 5/10 per month       |
| Pro        | $1M/mo       | 0.10%   | 0.10%    | 10/100 per month     |
| Enterprise | Unlimited    | 0%      | 0%       | Unlimited            |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
│  - Shows plan selection UI                                       │
│  - Redirects to Stripe Checkout or PingPay payment page         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend (nt-be)                               │
│                                                                  │
│  API Endpoints:                                                  │
│  - GET  /api/subscription/plans         → List all plans         │
│  - GET  /api/subscription/{account_id}  → Get subscription status│
│  - POST /api/subscription/checkout/*    → Create checkout (TODO) │
│  - POST /api/webhooks/stripe            → Stripe webhooks (TODO) │
│  - POST /api/webhooks/pingpay           → PingPay webhooks (TODO)│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PostgreSQL                                 │
│                                                                  │
│  Tables:                                                         │
│  - monitored_accounts  (plan_type, credits, credits_reset_at)   │
│  - subscriptions       (billing periods, provider info)          │
│  - payments            (transaction records)                     │
│  - usage_tracking      (monthly volume, fees)                    │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

### Configuration
| File | Purpose |
|------|---------|
| `nt-be/src/config/plans.rs` | Plan definitions, limits, pricing, fee calculations |
| `nt-be/src/config/mod.rs` | Exports plan types and config |

### API Handlers
| File | Purpose |
|------|---------|
| `nt-be/src/handlers/subscription/mod.rs` | Module exports |
| `nt-be/src/handlers/subscription/plans.rs` | GET plans and subscription status |

### Database
| File | Purpose |
|------|---------|
| `nt-be/migrations/20260203000001_add_subscription_system.sql` | All subscription tables |
| `nt-be/src/routes/monitored_accounts.rs` | Account CRUD with plan fields |

### Documentation
| File | Purpose |
|------|---------|
| `docs/PRICING.md` | Full pricing documentation with DB schema |

## Payment Providers

### Stripe (Recurring Subscriptions)

**Flow:**
1. User selects plan → Frontend calls `POST /api/subscription/checkout/stripe`
2. Backend creates Stripe Checkout Session → Returns redirect URL
3. User completes payment on Stripe → Stripe sends webhook
4. Backend receives `checkout.session.completed` webhook
5. Backend creates `subscription` record with `auto_renew = true`
6. Backend updates `monitored_accounts.plan_type`

**Key Fields:**
- `stripe_subscription_id` - Stripe's subscription ID (for managing/canceling)
- `stripe_customer_id` - Stripe customer for future payments
- `stripe_payment_intent_id` - Individual payment reference
- `stripe_card_brand`, `stripe_card_last4`, `stripe_card_first6` - Card tracking

**Billing Periods:** Monthly, Yearly (20% discount)

### PingPay (One-Time Crypto Payments)

**Important:** PingPay is NOT a subscription service. It's a one-time payment that grants access for a fixed period.

**Flow:**
1. User selects plan + period (6 or 12 months) → Frontend calls `POST /api/subscription/checkout/pingpay`
2. Backend creates PingPay payment request → Returns payment details
3. User sends crypto payment → PingPay sends webhook
4. Backend receives payment confirmation webhook
5. Backend creates `subscription` record with `auto_renew = false`
6. Backend sets `current_period_end` = now + 6/12 months
7. When period ends, subscription expires (no auto-renewal)

**Key Fields:**
- `pingpay_payment_id` - PingPay's payment reference
- `pingpay_wallet_address` - Wallet that made the payment
- `pingpay_transaction_hash` - On-chain transaction hash
- `crypto_amount`, `crypto_currency` - Payment details

**Billing Periods:** 6 months, 12 months (no monthly option)

## Fee System

### Exchange Fees
Applied to every token swap/exchange transaction.

```rust
// In config/plans.rs
pub fn calculate_exchange_fee(plan_type: PlanType, amount_cents: u64) -> u64 {
    let config = get_plan_config(plan_type);
    (amount_cents * config.limits.exchange_fee_bps as u64) / 10_000
}
```

**Collection:** Deducted from swap output before sending to user.

### Overage Fees
Applied when monthly outbound volume exceeds plan limit.

```rust
// In config/plans.rs
pub fn calculate_overage_fee(plan_type: PlanType, volume_cents: u64, limit_cents: u64) -> u64 {
    if volume_cents <= limit_cents {
        return 0;
    }
    let config = get_plan_config(plan_type);
    let overage = volume_cents - limit_cents;
    (overage * config.limits.overage_rate_bps as u64) / 10_000
}
```

**Collection:** Deducted from payment amounts when processing bulk payments.

## Credit System

### Types of Credits
- **Export Credits** - For CSV exports
- **Batch Payment Credits** - For bulk payment operations

### Reset Logic
```
Free Plan:
- 3 export credits, 3 batch payment credits (ONE-TIME trial)
- Never reset monthly
- If all used, must upgrade

Paid Plans (Plus, Pro):
- Credits reset on 1st of each month
- Reset to plan's monthly allocation

Enterprise:
- Unlimited (no tracking needed)

On Subscription Expiry:
- plan_type → 'free'
- Credits restored to free tier trial values (3/3)
```

### Checking Credits
```rust
// In config/plans.rs
pub fn has_export_credits(plan_type: PlanType, current_credits: i32) -> bool {
    if plan_type == PlanType::Enterprise {
        return true; // Unlimited
    }
    current_credits > 0
}
```

## Database Enums

```sql
-- Plan tiers
CREATE TYPE plan_type AS ENUM ('free', 'plus', 'pro', 'enterprise');

-- Subscription lifecycle
CREATE TYPE subscription_status AS ENUM ('active', 'cancelled', 'expired', 'past_due', 'trialing');

-- Payment providers
CREATE TYPE payment_provider AS ENUM ('stripe', 'pingpay');

-- Billing periods
CREATE TYPE billing_period AS ENUM ('monthly', 'six_months', 'yearly');

-- Payment status
CREATE TYPE payment_status AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled');
```

## Common Tasks

### Adding a New Plan Feature
1. Update `PlanLimits` struct in `config/plans.rs`
2. Add field to each plan in `get_plans_config()`
3. Update `docs/PRICING.md` documentation
4. Add migration if new DB column needed

### Checking User's Plan
```rust
use crate::config::{PlanType, get_plan_config};

// Get plan from monitored_accounts table
let account = sqlx::query_as::<_, MonitoredAccount>(
    "SELECT * FROM monitored_accounts WHERE account_id = $1"
)
.bind(&account_id)
.fetch_one(&pool)
.await?;

let plan_config = get_plan_config(account.plan_type);
let volume_limit = plan_config.limits.monthly_volume_limit_cents;
```

### Processing a Payment Webhook
```rust
// Stripe webhook
match event.type_.as_str() {
    "checkout.session.completed" => {
        // Create subscription record
        // Update monitored_accounts.plan_type
        // Set credits to plan defaults
    }
    "customer.subscription.deleted" => {
        // Set subscription.status = 'cancelled'
        // Downgrade to free plan
        // Reset credits to trial values
    }
    _ => {}
}
```

## Environment Variables

```bash
# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# PingPay (placeholder - partner will provide)
PINGPAY_API_KEY=
PINGPAY_API_URL=
PINGPAY_WEBHOOK_SECRET=

# Fee collection
FEE_RECIPIENT_WALLET=treasury26.near
```

## Testing

### Unit Tests
```bash
cargo test --package nt-be config::plans
```

### Key Test Cases
- Plan configuration completeness
- Fee calculations (overage, exchange)
- Credit initialization per plan
- Volume limit checks

## Implementation Status

| Feature | Status |
|---------|--------|
| Plan configuration | Done |
| GET /api/subscription/plans | Done |
| GET /api/subscription/{id} | Done |
| Database migrations | Done |
| Stripe checkout | TODO |
| Stripe webhooks | TODO |
| PingPay interface | TODO (placeholder) |
| Background credit reset | TODO |
| Fee deduction in payments | TODO |
