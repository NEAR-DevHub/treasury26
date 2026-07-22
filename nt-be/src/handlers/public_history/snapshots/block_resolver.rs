use std::error::Error;
use std::future::Future;

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use near_api::{Chain, NetworkConfig, Reference};
use serde::{Deserialize, Serialize};

use crate::services::public_balance_reader::with_transport_retry;
use crate::utils::cache::{Cache, CacheKey, CacheTier};

type BoxError = Box<dyn Error + Send + Sync>;
const MAX_CONSECUTIVE_SKIPPED_BLOCK_PROBES: u64 = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBlock {
    pub block_height: i64,
    pub block_hash: String,
    pub block_time: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcBlockPoint {
    height: u64,
    hash: String,
    timestamp_ns: i64,
}

fn point_from_header(
    height: u64,
    hash: String,
    timestamp_ns: u64,
) -> Result<RpcBlockPoint, BoxError> {
    Ok(RpcBlockPoint {
        height,
        hash,
        timestamp_ns: i64::try_from(timestamp_ns)
            .map_err(|_| std::io::Error::other("block timestamp exceeds i64"))?,
    })
}

fn resolved_from_point(point: RpcBlockPoint) -> ResolvedBlock {
    ResolvedBlock {
        block_height: point.height as i64,
        block_hash: point.hash,
        block_time: DateTime::from_timestamp_nanos(point.timestamp_ns),
    }
}

fn is_skipped_block_error(message: &str) -> bool {
    (message.contains("UnknownBlock") || message.contains("UNKNOWN_BLOCK"))
        && !message.contains("GarbageCollectedBlock")
}

/// Fetch the nearest existing block in `[lower_bound, candidate]`.
///
/// NEAR heights can be skipped, so a binary-search midpoint is not guaranteed
/// to identify an actual block. Scanning down only across the skipped run keeps
/// the timestamp search correct instead of treating a missing height as a
/// transport failure or returning a block after the requested timestamp. The
/// scan is bounded; pruning and generic provider failures remain fatal.
async fn fetch_existing_at_or_below(
    network: &NetworkConfig,
    candidate: u64,
    lower_bound: u64,
) -> Result<Option<RpcBlockPoint>, BoxError> {
    let mut height = candidate;
    let mut skipped_probes = 0_u64;
    loop {
        let result = with_transport_retry("snapshot_block_at_height", || {
            Chain::block()
                .at(Reference::AtBlock(height))
                .fetch_from(network)
        })
        .await;

        match result {
            Ok(block) => {
                return point_from_header(
                    block.header.height,
                    block.header.hash.to_string(),
                    block.header.timestamp,
                )
                .map(Some);
            }
            Err(error) => {
                let message = format!("{error:?} {error}");
                if !is_skipped_block_error(&message) {
                    return Err(error.into());
                }
                if height == lower_bound {
                    return Ok(None);
                }
                if skipped_probes >= MAX_CONSECUTIVE_SKIPPED_BLOCK_PROBES {
                    return Err(std::io::Error::other(format!(
                        "more than {MAX_CONSECUTIVE_SKIPPED_BLOCK_PROBES} consecutive skipped block heights below {candidate}"
                    ))
                    .into());
                }
                skipped_probes += 1;
                height -= 1;
            }
        }
    }
}

async fn binary_search_at_or_before<F, Fut>(
    latest: RpcBlockPoint,
    target_timestamp_ns: i64,
    mut fetch_at_or_below: F,
) -> Result<Option<RpcBlockPoint>, BoxError>
where
    F: FnMut(u64, u64) -> Fut,
    Fut: Future<Output = Result<Option<RpcBlockPoint>, BoxError>>,
{
    if latest.timestamp_ns <= target_timestamp_ns {
        return Ok(Some(latest));
    }

    let mut left = 0_u64;
    let mut right = latest.height;
    let mut best = None;

    while left <= right {
        let midpoint = left + (right - left) / 2;
        let Some(point) = fetch_at_or_below(midpoint, left).await? else {
            // No existing block in the lower half of the remaining range.
            left = midpoint.saturating_add(1);
            continue;
        };

        if point.timestamp_ns <= target_timestamp_ns {
            best = Some(point);
            left = midpoint.saturating_add(1);
        } else if point.height == 0 {
            break;
        } else {
            right = point.height - 1;
        }
    }

    Ok(best)
}

async fn resolve_uncached(
    network: &NetworkConfig,
    timestamp: DateTime<Utc>,
) -> Result<ResolvedBlock, BoxError> {
    let target_timestamp_ns = timestamp
        .timestamp_nanos_opt()
        .ok_or_else(|| std::io::Error::other("timestamp is outside nanosecond range"))?;

    let latest = with_transport_retry("snapshot_final_block", || {
        Chain::block().at(Reference::Final).fetch_from(network)
    })
    .await?;
    let latest = point_from_header(
        latest.header.height,
        latest.header.hash.to_string(),
        latest.header.timestamp,
    )?;

    if target_timestamp_ns > latest.timestamp_ns {
        return Err(std::io::Error::other(format!(
            "timestamp {timestamp} is after finalized block {} at {}",
            latest.height,
            DateTime::from_timestamp_nanos(latest.timestamp_ns)
        ))
        .into());
    }

    let point = binary_search_at_or_before(latest, target_timestamp_ns, |candidate, lower| {
        fetch_existing_at_or_below(network, candidate, lower)
    })
    .await?
    .ok_or_else(|| std::io::Error::other(format!("no block exists at or before {timestamp}")))?;

    Ok(resolved_from_point(point))
}

/// Resolve the latest finalized NEAR block at or before `timestamp` without
/// consulting any application ledger table.
pub async fn resolve_block_at_or_before(
    cache: &Cache,
    network: &NetworkConfig,
    timestamp: DateTime<Utc>,
) -> Result<ResolvedBlock, BoxError> {
    let timestamp_ns = timestamp
        .timestamp_nanos_opt()
        .ok_or_else(|| std::io::Error::other("timestamp is outside nanosecond range"))?;
    let key = CacheKey::new("public-snapshot-block-at-or-before")
        .with(timestamp_ns)
        .build();

    cache
        .cached(CacheTier::Immutable, key, async {
            resolve_uncached(network, timestamp)
                .await
                .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
        })
        .await
        .map_err(|(status, message)| {
            std::io::Error::other(format!("block resolution failed ({status}): {message}")).into()
        })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use super::*;

    fn point(height: u64, timestamp_ns: i64) -> RpcBlockPoint {
        RpcBlockPoint {
            height,
            hash: format!("hash-{height}"),
            timestamp_ns,
        }
    }

    async fn resolve_fixture(
        blocks: &[(u64, i64)],
        target_timestamp_ns: i64,
    ) -> Option<RpcBlockPoint> {
        let blocks = Arc::new(
            blocks
                .iter()
                .copied()
                .map(|(height, timestamp)| (height, point(height, timestamp)))
                .collect::<BTreeMap<_, _>>(),
        );
        let latest = blocks.last_key_value().unwrap().1.clone();

        binary_search_at_or_before(latest, target_timestamp_ns, |candidate, lower| {
            let blocks = Arc::clone(&blocks);
            async move {
                Ok(blocks
                    .range(lower..=candidate)
                    .next_back()
                    .map(|(_, point)| point.clone()))
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn returns_latest_existing_block_not_after_timestamp() {
        let blocks = [(0, 100), (1, 200), (2, 300), (4, 400), (5, 500), (7, 700)];

        assert_eq!(resolve_fixture(&blocks, 650).await.unwrap().height, 5);
        assert_eq!(resolve_fixture(&blocks, 400).await.unwrap().height, 4);
        assert_eq!(resolve_fixture(&blocks, 800).await.unwrap().height, 7);
        assert!(resolve_fixture(&blocks, 50).await.is_none());
    }

    #[tokio::test]
    async fn skipped_midpoint_heights_do_not_change_at_or_before_semantics() {
        let blocks = [(0, 100), (4, 400), (8, 800), (12, 1200)];

        let resolved = resolve_fixture(&blocks, 799).await.unwrap();

        assert_eq!(resolved.height, 4);
        assert_eq!(resolved.timestamp_ns, 400);
    }

    #[test]
    fn only_unknown_blocks_are_treated_as_skipped_heights() {
        assert!(is_skipped_block_error("RPC UnknownBlock at height 123"));
        assert!(is_skipped_block_error("UNKNOWN_BLOCK"));
        assert!(!is_skipped_block_error(
            "GarbageCollectedBlock: UnknownBlock"
        ));
        assert!(!is_skipped_block_error("HTTP 422 Unprocessable Entity"));
        assert!(!is_skipped_block_error("transport connection reset"));
    }
}
