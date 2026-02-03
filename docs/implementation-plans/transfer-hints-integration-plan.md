# Transfer Hint Providers Integration Plan

## Summary

Integrate external transfer APIs (starting with [FastNear transfers-api](https://github.com/fastnear/transfers-api)) to accelerate balance change detection. The RPC binary search remains the primary/fallback approach, but external providers can dramatically reduce search ranges by providing known block heights where transfers occurred.

## Motivation

Currently, gap filling uses binary search across potentially millions of blocks via RPC calls. While efficient at O(log n), large gaps still require ~20+ RPC calls. External APIs like FastNear's transfers-api can return transfer history with exact block heights, reducing this to 1 API call + 2-4 verification RPC calls.

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Gap Filler Service                        │
├─────────────────────────────────────────────────────────────┤
│                  TransferHintProvider                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ FastNear API │  │ NEAR Blocks  │  │ (future providers)│  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│              Binary Search (RPC fallback)                    │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### 1. Create provider abstraction

```rust
// nt-be/src/handlers/balance_changes/transfer_hints/mod.rs

use async_trait::async_trait;
use bigdecimal::BigDecimal;

/// A hint about where a balance change might have occurred
#[derive(Debug, Clone)]
pub struct TransferHint {
    pub block_height: u64,
    pub timestamp_ms: u64,
    pub amount: Option<BigDecimal>,
    pub counterparty: Option<String>,
    pub receipt_id: Option<String>,
}

/// Provider that can suggest block heights where transfers occurred
#[async_trait]
pub trait TransferHintProvider: Send + Sync {
    /// Provider name for logging
    fn name(&self) -> &'static str;

    /// Get transfer hints for an account/token in a block range
    async fn get_hints(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<TransferHint>, Box<dyn std::error::Error + Send + Sync>>;

    /// Check if provider supports this token type
    fn supports_token(&self, token_id: &str) -> bool;
}
```

### 2. Implement FastNear provider

- POST to `https://transfers.main.fastnear.com/v0/transfers`
- Filter by account, token type, and block range
- Handle pagination via `resume_token`
- Support NEAR native and FT tokens (intents tokens TBD)

### 3. Create orchestrator service

```rust
/// Orchestrates multiple hint providers with fallback
pub struct TransferHintService {
    providers: Vec<Box<dyn TransferHintProvider>>,
}

impl TransferHintService {
    pub fn new() -> Self {
        Self { providers: vec![] }
    }

    pub fn with_provider(mut self, provider: impl TransferHintProvider + 'static) -> Self {
        self.providers.push(Box::new(provider));
        self
    }

    /// Get hints from all providers that support the token, merging results
    pub async fn get_hints(
        &self,
        account_id: &str,
        token_id: &str,
        from_block: u64,
        to_block: u64,
    ) -> Vec<TransferHint> {
        // Query all providers, merge and deduplicate results
    }
}
```

### 4. Modify gap filler

- Try hints first, verify with RPC
- Fall back to binary search if hints don't match
- Optional via `hint_service: Option<&TransferHintService>`

### 5. Wire into AppState

- Add `transfer_hints: Option<TransferHintService>` to AppState
- Configure via environment variable (e.g., `TRANSFER_HINTS_ENABLED=true`)

## File Structure

```
nt-be/src/handlers/balance_changes/
├── transfer_hints/
│   ├── mod.rs           # Provider trait + orchestrator
│   ├── fastnear.rs      # FastNear transfers-api implementation
│   └── nearblocks.rs    # (future provider)
├── binary_search.rs     # Existing (unchanged, fallback)
├── gap_filler.rs        # Modified to use hints first
```

## Performance Comparison

| Scenario | Binary Search Only | With Hints |
|----------|-------------------|------------|
| Gap of 1M blocks | ~20 RPC calls | 1 API call + 2-4 RPC calls |
| Multiple gaps | O(n × log b) | O(n) API calls + O(n) RPC calls |
| Provider down | Works | Falls back gracefully |

## Key Design Decisions

1. **Hints, not source of truth**: External APIs provide hints; RPC verifies accuracy
2. **Provider abstraction**: Easy to add NearBlocks, Pikespeak, or other providers later
3. **Graceful degradation**: Binary search always available as fallback
4. **Token type awareness**: Each provider declares supported token types

## Future Providers

- NearBlocks API
- Pikespeak API
- Custom indexer

## References

- FastNear transfers-api: https://github.com/fastnear/transfers-api
- Current binary search implementation: `nt-be/src/handlers/balance_changes/binary_search.rs`
- Current gap filler: `nt-be/src/handlers/balance_changes/gap_filler.rs`
