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
