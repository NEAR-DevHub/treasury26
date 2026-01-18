## Proxy API Endpoint for Asset Exchange Quotes

### Background

The 1click API (https://1click.chaindefuser.com) provides swap quotes for NEAR Intents. We need a proxy endpoint in nt-be that:
- Accepts the same request body as the 1click API quote endpoint
- Overrides `appFees` and `referral` fields from environment variables
- Forwards to 1click API with JWT authentication
- Returns the response to the caller

### Technical Details

- **1click API Base URL**: `https://1click.chaindefuser.com`
- **1click Quote Endpoint**: `POST /v0/quote`
- **Documentation**: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api#post-v0-quote

### Environment Variables Needed

| Variable | Description | Example |
|----------|-------------|---------|
| `ONECLICK_API_URL` | 1click API base URL | `https://1click.chaindefuser.com` |
| `ONECLICK_JWT_TOKEN` | JWT token for authentication | `eyJ...` |
| `ONECLICK_APP_FEE_BPS` | Fee in basis points | `50` |
| `ONECLICK_APP_FEE_RECIPIENT` | NEAR account for fees | `treasury.near` |
| `ONECLICK_REFERRAL` | Referral identifier | `near-treasury` |

### Requirements

- No authentication required on the proxy endpoint
- No address validation (we benefit from any usage via appFees)
- No rate limiting at this point

---

### Implementation Details

#### Technology Stack
- **Framework**: **Axum** (Rust async web framework)
- **HTTP Client**: `reqwest::Client` (already available in `AppState`)
- **Caching**: `moka` async cache with `CacheTier::ShortTerm` / `CacheTier::LongTerm`

#### Route Pattern
The codebase follows `/api/{domain}/{resource|action}` convention. Existing intents endpoints:
- `GET /api/intents/search-tokens`
- `POST /api/intents/deposit-address`
- `GET /api/intents/deposit-assets`

#### New Endpoint
- **Route URL**: `POST /api/intents/quote`
- **New handler file**: `nt-be/src/handlers/intents/quote.rs`
- **Update module**: Add `pub mod quote;` to `nt-be/src/handlers/intents/mod.rs`
- **Register route**: Add to `nt-be/src/routes/mod.rs`

#### Environment Variables
Add to `EnvVars` struct in `nt-be/src/utils/env.rs`:

```rust
pub oneclick_api_url: String,
pub oneclick_jwt_token: Option<String>,
pub oneclick_app_fee_bps: Option<u32>,
pub oneclick_app_fee_recipient: Option<String>,
pub oneclick_referral: Option<String>,
```

#### Handler Pattern to Follow
Use `deposit_address.rs` as reference - it demonstrates:
- JSON body parsing with `Json<RequestType>`
- External API calls via `state.http_client`
- Error handling with `(StatusCode, String)` returns
- Optional caching with `CacheKey` and `CacheTier`

#### Example Handler Skeleton

```rust
use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::AppState;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    pub dry_run: Option<bool>,
    pub swaps: Vec<SwapParams>,
    // Note: appFees and referral are NOT accepted from client
}

pub async fn get_quote(
    State(state): State<Arc<AppState>>,
    Json(request): Json<QuoteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Build request with injected appFees and referral from env vars
    // Forward to 1click API with JWT auth header
    // Return response
}
```

#### Route Registration
In `nt-be/src/routes/mod.rs`:
```rust
.route(
    "/api/intents/quote",
    post(handlers::intents::quote::get_quote),
)
```

### Files to Modify/Create

| File | Action |
|------|--------|
| `nt-be/src/handlers/intents/quote.rs` | **Create** - New handler |
| `nt-be/src/handlers/intents/mod.rs` | **Modify** - Add `pub mod quote;` |
| `nt-be/src/routes/mod.rs` | **Modify** - Register new route |
| `nt-be/src/utils/env.rs` | **Modify** - Add 1click env vars to `EnvVars` struct |

### Testing

```bash
curl -X POST http://localhost:8080/api/intents/quote \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": true,
    "swaps": [{
      "tokenIn": "wrap.near",
      "tokenOut": "usdt.tether-token.near",
      "amountIn": "1000000000000000000000000"
    }]
  }'
```
