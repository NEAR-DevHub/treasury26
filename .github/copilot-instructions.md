# Copilot Instructions for Treasury26

## Test-Driven Development Approach

**Every phase follows TDD:**
1. Write integration test first (can fail initially)
2. Write unit tests for the component
3. Implement the minimum code to pass tests
4. Refactor while keeping tests green

Integration tests are written early and updated as new functionality is added. They serve as living documentation and ensure components work together correctly.

## Testing Guidelines

### Hard Assertions in Tests
Always use hard assertions in tests without fallbacks. Tests should fail fast with explicit error messages.

**Do:**
```rust
assert!(!page1.is_empty(), "Page 1 should not be empty");
let change = changes.first().expect("Should have at least one change");
```

**Don't:**
```rust
if !page1.is_empty() {
    // test logic
}
if let Some(change) = changes.first() {
    // test logic
}
```

This ensures tests fail immediately with clear error messages rather than silently continuing when data is missing.

### Use API Methods in Tests
When tests need to register accounts, create resources, or perform actions that have API endpoints, use the actual API routes instead of inserting directly into the database. This ensures tests validate the full request path including validation, side effects (like setting `dirty_at`, granting credits), and response handling.

**Do:**
```rust
// Register account via API endpoint (same as frontend)
let app_state = nt_be::AppState::builder()
    .db_pool(pool.clone())
    .build()
    .await?;
let app = nt_be::routes::create_routes(Arc::new(app_state));

let response = app
    .oneshot(
        axum::http::Request::builder()
            .method("POST")
            .uri("/api/monitored-accounts")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::json!({ "accountId": ACCOUNT_ID }).to_string(),
            ))
            .unwrap(),
    )
    .await
    .unwrap();

assert_eq!(response.status(), axum::http::StatusCode::OK);
```

**Don't:**
```rust
// Directly inserting into the database bypasses validation and side effects
sqlx::query!(
    "INSERT INTO monitored_accounts (account_id) VALUES ($1)",
    account_id
)
.execute(&pool)
.await?;
```

### Prefer End-to-End Tests Over Redundant Unit Tests
Don't create multiple tests that cover the same logic at different levels. Instead, write one test that covers the full end-to-end scenario. A monitoring cycle test that registers via API, runs the cycle, and checks results already covers `fill_gaps` — there's no need for a separate `fill_gaps` test.

### No Test Simulations
Never simulate or fake behavior to make tests pass. Tests must call the actual implementation and fail when functionality is incomplete.

**Do:**
```rust
// Test calls the actual monitoring system
run_monitor_cycle(&pool, &network, up_to_block).await?;

// Verify the system automatically discovered and tracked the token
let tokens = get_tracked_tokens(&pool, account_id).await?;
assert!(tokens.contains("discovered-token.near"));
```

**Don't:**
```rust
// Manually simulating what the system should do
let discovered = discover_tokens_manually(...);
fill_gaps(&pool, &network, account_id, "discovered-token.near", up_to_block).await?;

// Test passes but doesn't validate the real implementation
```

This ensures tests drive implementation through TDD - they fail until the real functionality is complete.

## Pre-Commit Checks

Always run `cargo fmt` and `cargo clippy` before committing. Code that doesn't pass formatting or has clippy warnings should not be committed.

```bash
cargo fmt
cargo clippy --all-targets
```

## Pull Request Guidelines

### Conventional Commits

All PR titles and descriptions must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

**PR Title Format:**
```
<type>: <description>
```

**Types:**
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that don't affect code meaning (formatting, etc.)
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `perf`: Performance improvement
- `test`: Adding or correcting tests
- `chore`: Changes to build process or auxiliary tools

**Examples:**
```
feat: add user authentication with OAuth2
fix: resolve race condition in balance updates
refactor: extract token lookup into separate module
```

**PR Description** should include:
- Summary of changes (bulleted list)
- Test plan or verification steps

## Rust Code Guidelines

### Import Organization
Move `use` statements to the top of the file or module, not inside functions.

**Do:**
```rust
use bigdecimal::ToPrimitive;
use chrono::NaiveDate;

async fn enrich_snapshots_with_prices(...) {
    // function body
}
```

**Don't:**
```rust
async fn enrich_snapshots_with_prices(...) {
    use bigdecimal::ToPrimitive;  // Move to top of file
    use chrono::NaiveDate;        // Move to top of file
    // function body
}
```

### Avoid Code Duplication
When the same logic (like parsing timestamps) is done multiple times, extract it to avoid repetition.

**Do:**
```rust
// Parse once and reuse
let parsed_dates: Vec<_> = token_snapshots
    .iter()
    .filter_map(|s| DateTime::parse_from_rfc3339(&s.timestamp).ok())
    .map(|dt| dt.date_naive())
    .collect();

// Use parsed_dates for both collecting unique dates AND enriching snapshots
```

**Don't:**
```rust
// First loop: parse timestamps
for s in token_snapshots.iter() {
    if let Ok(dt) = DateTime::parse_from_rfc3339(&s.timestamp) { ... }
}

// Second loop: parse same timestamps again
for snapshot in token_snapshots.iter_mut() {
    if let Ok(dt) = DateTime::parse_from_rfc3339(&snapshot.timestamp) { ... }
}
```

### Use Batch Operations for Database Inserts
When inserting multiple rows, prefer batch insert operations over individual inserts in a loop.

**Do:**
```rust
// Single batch insert for all prices
sqlx::query!(
    "INSERT INTO prices (asset_id, date, price) SELECT * FROM UNNEST($1, $2, $3)",
    &asset_ids,
    &dates,
    &prices
).execute(&pool).await?;
```

**Don't:**
```rust
// Individual inserts in a loop - inefficient
for (&date, &price) in &all_prices {
    sqlx::query!(
        "INSERT INTO prices (asset_id, date, price) VALUES ($1, $2, $3)",
        asset_id, date, price
    ).execute(&pool).await?;
}
```

### Prefer Simple Reference Passing
Use `&` references instead of `Option<&T>.as_ref()` when possible.

**Do:**
```rust
fn generate_csv(pool: &PgPool, price_service: Option<&PriceLookupService<P>>, ...) { ... }

// Call with direct reference
generate_csv(&state.db_pool, state.price_service.as_deref(), ...)
```

**Don't:**
```rust
fn generate_csv(pool: &PgPool, price_service: Option<&PriceLookupService<P>>, ...) { ... }

// Unnecessary .as_ref() that could be simplified
generate_csv(&state.db_pool, state.price_service.as_ref(), ...)
```

### Use Defaults at Configuration Level
When configuration values have sensible defaults, set them at the environment/config level rather than checking everywhere they're used.

**Do:**
```rust
// In env.rs - set default at source
coingecko_api_base_url: std::env::var("COINGECKO_API_BASE_URL")
    .ok()
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "https://pro-api.coingecko.com/api/v3".to_string()),

// In usage - always use the value directly
CoinGeckoClient::new(http_client, api_key, env_vars.coingecko_api_base_url)
```

**Don't:**
```rust
// In env.rs - optional with no default
coingecko_api_base_url: std::env::var("COINGECKO_API_BASE_URL").ok(),

// In usage - check and provide default every time
let client = if let Some(base_url) = &env_vars.coingecko_api_base_url {
    CoinGeckoClient::with_base_url(http_client, api_key, base_url)
} else {
    CoinGeckoClient::new(http_client, api_key)  // Has hardcoded default
};
```

### Plan for Future Extensibility
When creating mappings or configurations that may grow, consider:
- Adding tests to verify all supported items have corresponding mappings
- Documenting where mappings come from and how to maintain them
- Consider if upstream sources (like token registries) could provide the data

**Example - Test for mapping completeness:**
```rust
#[test]
fn test_all_tokens_have_price_provider_mapping() {
    let tokens = get_tokens_map();
    let provider = CoinGeckoClient::new(...);
    
    for (unified_id, _) in tokens.iter() {
        assert!(
            provider.translate_asset_id(unified_id).is_some(),
            "Missing CoinGecko mapping for token: {}", unified_id
        );
    }
}
```
