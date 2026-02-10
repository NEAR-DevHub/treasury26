# AI Guide: Subscription & Plan System

This document provides context for AI assistants working on Treasury26's plan system.

## Launch Status

**For launch, all new users automatically receive Pro plan.** Payment processing (Stripe, PingPay) has been deferred. The plan system and metrics tracking are in place for future monetization.

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
│  - Shows plan info in UI                                         │
│  - Displays credits and usage                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend (nt-be)                               │
│                                                                  │
│  API Endpoints:                                                  │
│  - GET  /api/subscription/plans         → List all plans         │
│  - GET  /api/subscription/{account_id}  → Get plan status        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PostgreSQL                                 │
│                                                                  │
│  Tables:                                                         │
│  - monitored_accounts  (plan_type, credits, credits_reset_at)   │
│  - usage_tracking      (monthly volume, fees - for metrics)     │
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
| `nt-be/migrations/20260204000002_add_subscription_system.sql` | Plan and usage tracking tables |
| `nt-be/src/routes/monitored_accounts.rs` | Account CRUD with plan fields (defaults to Pro) |

### Documentation
| File | Purpose |
|------|---------|
| `docs/PRICING.md` | Full pricing documentation |

## Fee System (Future)

Fee calculations are implemented but not currently collected. They're tracked in `usage_tracking` for future monetization.

### Exchange Fees
Applied to every token swap/exchange transaction.

```rust
// In config/plans.rs
pub fn calculate_exchange_fee(plan_type: PlanType, amount_cents: u64) -> u64 {
    let config = get_plan_config(plan_type);
    (amount_cents * config.limits.exchange_fee_bps as u64) / 10_000
}
```

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

## Database Schema

```sql
-- Plan tiers
CREATE TYPE plan_type AS ENUM ('free', 'plus', 'pro', 'enterprise');

-- monitored_accounts columns
plan_type plan_type NOT NULL DEFAULT 'free'  -- DB default, API assigns 'pro'
credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

-- usage_tracking table (for metrics)
- outbound_volume_cents, exports_used, batch_payments_used
- exchanges_count, exchanges_volume_cents
- overage_volume_cents, overage_fees_cents, exchange_fees_cents
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
| Default Pro for new users | Done |
| Usage tracking table | Done |
| Background credit reset | TODO |
| Fee collection | Deferred |
| Payment processing | Deferred |
