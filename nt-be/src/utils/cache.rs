use axum::http::StatusCode;
use moka::future::Cache as MokaCache;
use near_api::errors::QueryError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt::Display;

/// Cache tier types for different data characteristics
#[derive(Debug, Clone, Copy)]
pub enum CacheTier {
    /// Long-lived data (5 minutes TTL) - metadata, configs, lookups
    LongTerm,
    /// Frequently changing data (30 seconds TTL) - balances, policies
    ShortTerm,
    /// Historical/immutable data (very long TTL) - block data, historical balances
    /// Note: Implementation for immutable cache is not included yet
    #[allow(dead_code)]
    Immutable,
}

/// Cache manager that provides unified access to different cache tiers
#[derive(Clone)]
pub struct Cache {
    /// Long-term cache (5 minutes TTL)
    pub long_term: MokaCache<String, Value>,
    /// Short-term cache (30 seconds TTL)
    pub short_term: MokaCache<String, Value>,
}

pub enum CacheError {
    Message(String),
    Full(StatusCode, String),
}

impl From<String> for CacheError {
    fn from(s: String) -> Self {
        CacheError::Message(s)
    }
}

impl From<&str> for CacheError {
    fn from(s: &str) -> Self {
        CacheError::Message(s.to_string())
    }
}

impl From<(StatusCode, String)> for CacheError {
    fn from(e: (StatusCode, String)) -> Self {
        CacheError::Full(e.0, e.1)
    }
}

impl From<CacheError> for (StatusCode, String) {
    fn from(e: CacheError) -> Self {
        match e {
            CacheError::Message(s) => (StatusCode::INTERNAL_SERVER_ERROR, s),
            CacheError::Full(s, msg) => (s, msg),
        }
    }
}

impl Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CacheError::Message(s) => write!(f, "{}", s),
            CacheError::Full(s, msg) => write!(f, "{}: {}", s, msg),
        }
    }
}

impl Cache {
    /// Create a new Cache manager with default configuration
    /// - Long-term cache: 10,000 entries, 5 minutes TTL
    /// - Short-term cache: 1,000 entries, 30 seconds TTL
    pub fn new() -> Self {
        use std::time::Duration;

        let long_term = MokaCache::builder()
            .max_capacity(10_000)
            .time_to_live(Duration::from_secs(300)) // 5 minutes
            .build();

        let short_term = MokaCache::builder()
            .max_capacity(1_000)
            .time_to_live(Duration::from_secs(30)) // 30 seconds
            .build();

        Self {
            long_term,
            short_term,
        }
    }

    /// Create a new Cache manager with custom configuration
    pub fn with_config(
        long_term_capacity: u64,
        long_term_ttl_secs: u64,
        short_term_capacity: u64,
        short_term_ttl_secs: u64,
    ) -> Self {
        use std::time::Duration;

        let long_term = MokaCache::builder()
            .max_capacity(long_term_capacity)
            .time_to_live(Duration::from_secs(long_term_ttl_secs))
            .build();

        let short_term = MokaCache::builder()
            .max_capacity(short_term_capacity)
            .time_to_live(Duration::from_secs(short_term_ttl_secs))
            .build();

        Self {
            long_term,
            short_term,
        }
    }

    /// Get the appropriate cache based on the tier
    fn get_cache(&self, tier: CacheTier) -> &MokaCache<String, Value> {
        match tier {
            CacheTier::LongTerm => &self.long_term,
            CacheTier::ShortTerm => &self.short_term,
            CacheTier::Immutable => &self.long_term, // TODO: implement separate immutable cache
        }
    }

    /// Cached function execution with automatic tier selection
    ///
    /// # Arguments
    /// * `tier` - Cache tier to use (LongTerm, ShortTerm, or Immutable)
    /// * `cache_key` - The key to store/retrieve from cache
    /// * `fetch_fn` - Async function that fetches the data if cache miss
    ///
    /// # Returns
    /// * `Ok((StatusCode::OK, Json(Value)))` on success
    /// * `Err((StatusCode, String))` on error
    pub async fn cached_json<F, T, E>(
        &self,
        tier: CacheTier,
        cache_key: String,
        fetch_fn: F,
    ) -> Result<(StatusCode, axum::Json<Value>), (StatusCode, String)>
    where
        F: std::future::Future<Output = Result<T, E>>,
        T: Serialize,
        E: Into<CacheError>,
    {
        let cache = self.get_cache(tier);
        cached_json(cache, cache_key, fetch_fn).await
    }

    /// Cached function execution that returns the deserialized type
    ///
    /// # Arguments
    /// * `tier` - Cache tier to use
    /// * `cache_key` - The key to store/retrieve from cache
    /// * `fetch_fn` - Async function that fetches the data if cache miss
    ///
    /// # Returns
    /// * `Ok(T)` with the deserialized data on success
    /// * `Err((StatusCode, String))` on error
    pub async fn cached<F, T, E>(
        &self,
        tier: CacheTier,
        cache_key: String,
        fetch_fn: F,
    ) -> Result<T, (StatusCode, String)>
    where
        F: std::future::Future<Output = Result<T, E>>,
        T: Serialize + for<'de> Deserialize<'de>,
        E: Into<CacheError>,
    {
        let cache = self.get_cache(tier);
        cached(cache, cache_key, fetch_fn).await
    }

    /// Specialized helper for contract view calls with caching
    ///
    /// # Arguments
    /// * `tier` - Cache tier to use
    /// * `cache_key` - The key for caching this specific contract call
    /// * `fetch_fn` - Async function that makes the contract call
    ///
    /// # Returns
    /// * `Ok(T)` with the deserialized data on success
    /// * `Err((StatusCode, String))` on error
    pub async fn cached_contract_call<F, T, E>(
        &self,
        tier: CacheTier,
        cache_key: String,
        fetch_fn: F,
    ) -> Result<T, (StatusCode, String)>
    where
        E: Display + Send + Sync + std::fmt::Debug,
        F: std::future::Future<Output = Result<T, QueryError<E>>>,
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let cache = self.get_cache(tier);
        cached(cache, cache_key, async move {
            fetch_fn.await.map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Contract call error: {}", e),
                )
            })
        })
        .await
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper to build consistent cache keys across the application
pub struct CacheKey {
    namespace: String,
    parts: Vec<String>,
}

impl CacheKey {
    /// Create a new cache key with a namespace
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            parts: Vec::new(),
        }
    }

    /// Add a part to the cache key
    pub fn with(mut self, part: impl Display) -> Self {
        self.parts.push(part.to_string());
        self
    }

    /// Build the final cache key string
    pub fn build(self) -> String {
        if self.parts.is_empty() {
            self.namespace
        } else {
            format!("{}:{}", self.namespace, self.parts.join(":"))
        }
    }
}

/// Cached function execution wrapper
///
/// This function checks the cache first, and if not found, executes the provided
/// function, caches the result as JSON, and returns it.
///
/// # Arguments
/// * `cache` - The Moka cache to use
/// * `cache_key` - The key to store/retrieve from cache
/// * `fetch_fn` - Async function that fetches the data if cache miss
///
/// # Returns
/// * `Ok((StatusCode::OK, Json(Value)))` on success
/// * `Err((StatusCode, String))` on error
pub async fn cached_json<F, T, E>(
    cache: &MokaCache<String, Value>,
    cache_key: String,
    fetch_fn: F,
) -> Result<(StatusCode, axum::Json<Value>), (StatusCode, String)>
where
    F: std::future::Future<Output = Result<T, E>>,
    T: Serialize,
    E: Into<CacheError>,
{
    // Check cache first
    if let Some(cached_data) = cache.get(&cache_key).await {
        return Ok((StatusCode::OK, axum::Json(cached_data)));
    }

    // Cache miss - fetch the data
    let result = fetch_fn.await.map_err(|e| {
        let err: CacheError = e.into();
        eprintln!("Error fetching data: {}", err);
        let res: (StatusCode, String) = err.into();
        res
    })?;

    // Serialize to JSON
    let result_value = serde_json::to_value(&result).map_err(|e| {
        eprintln!("Error serializing result: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize result".to_string(),
        )
    })?;

    // Store in cache
    cache.insert(cache_key, result_value.clone()).await;

    Ok((StatusCode::OK, axum::Json(result_value)))
}

/// Cached function execution wrapper that returns the deserialized type
///
/// Similar to `cached_json` but deserializes the cached value back to the original type.
/// This is useful when you need to work with the typed data after caching.
///
/// # Arguments
/// * `cache` - The Moka cache to use
/// * `cache_key` - The key to store/retrieve from cache
/// * `fetch_fn` - Async function that fetches the data if cache miss
///
/// # Returns
/// * `Ok(T)` with the deserialized data on success
/// * `Err((StatusCode, String))` on error
pub async fn cached<F, T, E>(
    cache: &MokaCache<String, Value>,
    cache_key: String,
    fetch_fn: F,
) -> Result<T, (StatusCode, String)>
where
    F: std::future::Future<Output = Result<T, E>>,
    T: Serialize + for<'de> Deserialize<'de>,
    E: Into<CacheError>,
{
    // Check cache first
    if let Some(cached_data) = cache.get(&cache_key).await {
        return serde_json::from_value(cached_data).map_err(|e| {
            eprintln!("Error deserializing cached data: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to deserialize cached data".to_string(),
            )
        });
    }

    // Cache miss - fetch the data
    let result = fetch_fn.await.map_err(|e| {
        let err: CacheError = e.into();
        eprintln!("Error fetching data: {}", err);
        let res: (StatusCode, String) = err.into();
        res
    })?;

    // Serialize to JSON and store in cache
    let result_value = serde_json::to_value(&result).map_err(|e| {
        eprintln!("Error serializing result: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize result".to_string(),
        )
    })?;

    cache.insert(cache_key, result_value).await;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_key_builder() {
        let key = CacheKey::new("token-balance")
            .with("account.near")
            .with("token.near")
            .build();
        assert_eq!(key, "token-balance:account.near:token.near");

        let key = CacheKey::new("simple").build();
        assert_eq!(key, "simple");
    }
}
