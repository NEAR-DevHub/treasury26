# Copilot Instructions for Treasury26

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
