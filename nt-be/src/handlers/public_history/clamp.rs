//! Operator controls for DAOs whose public-history backfill volume is
//! disproportionate: stop the bronze pipeline entirely, or clamp an account
//! to the current chain head instead of walking its full history.
//!
//! Scoped deliberately narrow: only `monitored_accounts.history_ingestion_paused_at`
//! and the bronze/silver/gold public-history pipeline are touched. Proposal
//! refresh, DAO policy sync, balance-monitor maintenance, verification, and
//! confidential monitoring all key off `monitored_accounts.enabled`, which
//! this module never writes.
//!
//! Readers that report ledger coverage or verify running-balance invariants
//! must scope to rows at/after `bronze_public_history_cursors.capped_at_block_height`
//! for a capped account — see `verification/repository.rs::load_asset_ledger_heads`
//! and `charts/repository.rs`'s `ledger_coverage_start`, which both do this.
//!
//! The silver projector needs the same awareness for a different reason:
//! `silver/worker.rs::project_public_silver_for_account` skips an account
//! entirely until `backfill_done`, so for a mid-backfill account (the
//! primary reason to clamp one) silver has never run at all. The moment a
//! clamp flips `backfill_done`, that account's first-ever projection would
//! otherwise recompute from `earliest_bronze_time` — a from-scratch replay
//! of a known-partial bronze slice, seeded from nothing, completely
//! bypassing this module's anchor. `silver/repository.rs::load_capped_at_time`
//! plus the floor on `recompute_from` in `silver/worker.rs` is what makes
//! the anchor actually load-bearing instead of decorative.

use std::collections::HashSet;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use near_api::{Chain, NetworkConfig, Reference};
use sqlx::PgPool;

use crate::handlers::balance_changes::balance::{
    ft as ft_balance, intents as intents_balance, near as near_balance,
};
use crate::handlers::balance_changes::counterparty::ensure_ft_metadata;
use crate::handlers::balance_changes::token_discovery::{
    fetch_fastnear_ft_tokens, snapshot_intents_tokens,
};
use crate::handlers::balance_changes::utils::{block_timestamp_to_datetime, with_transport_retry};
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::gold::unified::sync_hidden_ledger_rows;
use crate::handlers::public_history::silver::models::{PublicAsset, PublicTokenStandard};
use crate::handlers::public_history::silver::normalize::canonical_nep245_token_id;

pub type ClampError = Box<dyn std::error::Error + Send + Sync>;

const NATIVE_DECIMALS: i32 = 24;
/// Observation entries sort after real movements but before verification
/// rebases inside a block — same convention as the staking-observation
/// writer's `OBSERVATION_INTRA_BLOCK_SEQ`.
const CLAMP_ANCHOR_INTRA_BLOCK_SEQ: i32 = 900_000;

#[derive(Debug, Clone)]
pub struct ClampSummary {
    pub block_height: i64,
    pub assets_anchored: usize,
}

/// Stop the public-history bronze pipeline for this account. Every other
/// system (proposals, policy sync, balance monitor, verification) keeps
/// running — only latest/backfill/readiness dispatch in `scheduler.rs`
/// checks this flag. Also supersedes any durable realtime demand already
/// queued: `load_ready_latest_demands` doesn't check the pause flag itself,
/// so a demand left in place would keep dispatching (and, if its trigger
/// transaction predates wherever the account resumes from later, retry
/// forever without ever finding it).
pub async fn stop_history_ingestion(pool: &PgPool, account_id: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        UPDATE monitored_accounts
        SET history_ingestion_paused_at = NOW(), updated_at = NOW()
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM public_history_latest_demands WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

struct AssetBalance {
    asset: PublicAsset,
    balance: BigDecimal,
    decimals: i32,
}

async fn resolve_head_block(network: &NetworkConfig) -> Result<(i64, DateTime<Utc>), ClampError> {
    let block = with_transport_retry("clamp_head_block", || {
        Chain::block().at(Reference::Final).fetch_from(network)
    })
    .await
    .map_err(|e| e.to_string())?;
    let block_height = block.header.height as i64;
    let block_time = block_timestamp_to_datetime(block.header.timestamp as i64);
    Ok((block_height, block_time))
}

/// Resolve one asset's balance/decimals at `block_height` and push it,
/// deduping by `token_id()` against assets already resolved.
async fn resolve_and_push(
    resolved: &mut Vec<AssetBalance>,
    seen: &mut HashSet<String>,
    pool: &PgPool,
    network: &NetworkConfig,
    account_id: &str,
    block_height: u64,
    asset: PublicAsset,
) -> Result<(), ClampError> {
    if !seen.insert(asset.token_id().to_string()) {
        return Ok(());
    }
    let (balance, decimals) = match asset.token_standard() {
        PublicTokenStandard::Native => (
            near_balance::get_balance_at_block(network, account_id, block_height)
                .await
                .map_err(|e| e.to_string())?,
            NATIVE_DECIMALS,
        ),
        PublicTokenStandard::Nep141 => {
            let decimals = ensure_ft_metadata(pool, network, asset.token_id())
                .await
                .map_err(|e| e.to_string())?;
            let balance = ft_balance::get_balance_at_block(
                pool,
                network,
                account_id,
                asset.token_id(),
                block_height,
            )
            .await
            .map_err(|e| e.to_string())?;
            (balance, decimals as i32)
        }
        PublicTokenStandard::Nep245 => {
            let decimals = intents_balance::resolve_decimals(pool, network, asset.token_id())
                .await
                .map_err(|e| e.to_string())?;
            let balance = intents_balance::get_balance_at_block(
                pool,
                network,
                account_id,
                asset.token_id(),
                block_height,
            )
            .await
            .map_err(|e| e.to_string())?;
            (balance, decimals as i32)
        }
    };
    resolved.push(AssetBalance {
        asset,
        balance,
        decimals,
    });
    Ok(())
}

/// Every asset the account needs an anchor for: what it currently holds
/// (discovered independently of our own bronze ingestion — FastNear's live
/// indexer + intents.near's own `mt_tokens_for_owner`, so a heavy DAO's
/// undertracked history doesn't blind discovery) UNION every asset it has
/// ever had a ledger entry for. The union matters for correctness, not just
/// completeness: an asset fully disposed of before the clamp (or while
/// paused) would otherwise keep whatever stale positive balance the old,
/// possibly-incomplete pre-clamp history left behind, since nothing else
/// would ever write a closing entry for it. Using the account's own history
/// as the registry also covers NEP-245 contracts outside intents.near,
/// which neither live-discovery source enumerates.
async fn discover_held_assets(
    pool: &PgPool,
    network: &NetworkConfig,
    http_client: &reqwest::Client,
    fastnear_api_key: &str,
    account_id: &str,
    block_height: u64,
) -> Result<Vec<AssetBalance>, ClampError> {
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();

    resolve_and_push(
        &mut resolved,
        &mut seen,
        pool,
        network,
        account_id,
        block_height,
        PublicAsset::native_near(),
    )
    .await?;

    let ft_contracts = fetch_fastnear_ft_tokens(http_client, fastnear_api_key, account_id)
        .await
        .map_err(|e| e.to_string())?;
    for contract in ft_contracts {
        resolve_and_push(
            &mut resolved,
            &mut seen,
            pool,
            network,
            account_id,
            block_height,
            PublicAsset::nep141(contract),
        )
        .await?;
    }

    let intents_tokens = snapshot_intents_tokens(network, account_id)
        .await
        .map_err(|e| e.to_string())?;
    for full_token_id in intents_tokens {
        let bare_token_id = full_token_id
            .strip_prefix("intents.near:")
            .unwrap_or(&full_token_id)
            .to_string();
        resolve_and_push(
            &mut resolved,
            &mut seen,
            pool,
            network,
            account_id,
            block_height,
            PublicAsset::intents(bare_token_id),
        )
        .await?;
    }

    // silver_balance_history is the natural place to look for historically-
    // known assets, but for the primary clamp scenario — an account still
    // mid-backfill, which is exactly why it's being clamped — silver has
    // never projected anything for it at all (project_public_silver_for_account
    // skips accounts until backfill_done). Bronze is what's actually
    // populated there, so it's the union member that matters most in
    // practice; silver stays as a second pass for accounts that did already
    // have projected history before being stopped and restarted.
    let bronze_assets: Vec<(String, String, Option<String>)> = sqlx::query_as(
        r#"
        SELECT DISTINCT source::text, contract_account_id, token_id
        FROM bronze_public_history_events
        WHERE account_id = $1
          AND source IN (
              'nearblocks_ft'::public_history_source,
              'nearblocks_mt'::public_history_source
          )
          AND contract_account_id IS NOT NULL
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    for (source, contract, token_id) in bronze_assets {
        let asset = match source.as_str() {
            "nearblocks_ft" => PublicAsset::nep141(contract),
            "nearblocks_mt" => {
                let Some(token_id) = token_id else { continue };
                if contract == "intents.near" {
                    PublicAsset::intents(token_id)
                } else {
                    PublicAsset::nep245(canonical_nep245_token_id(&contract, &token_id))
                }
            }
            _ => continue,
        };
        if seen.contains(asset.token_id()) {
            continue;
        }
        resolve_and_push(
            &mut resolved,
            &mut seen,
            pool,
            network,
            account_id,
            block_height,
            asset,
        )
        .await?;
    }

    let historical: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT DISTINCT ON (asset) asset, token_standard::text
        FROM silver_balance_history
        WHERE account_id = $1
        ORDER BY asset, block_height DESC, intra_block_seq DESC
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    for (asset_str, standard_str) in historical {
        if seen.contains(&asset_str) {
            continue;
        }
        let Ok(standard) = PublicTokenStandard::from_db(&standard_str) else {
            continue;
        };
        let asset = match standard {
            PublicTokenStandard::Native => PublicAsset::native_near(),
            PublicTokenStandard::Nep141 => PublicAsset::nep141(asset_str),
            PublicTokenStandard::Nep245 => PublicAsset::nep245(asset_str),
        };
        resolve_and_push(
            &mut resolved,
            &mut seen,
            pool,
            network,
            account_id,
            block_height,
            asset,
        )
        .await?;
    }

    Ok(resolved)
}

/// Clamp an account's public history to the current chain head: seed an
/// accurate balance anchor per known asset (see `discover_held_assets`) so
/// the ledger stays correct with no genesis-to-head coverage, pin all 3
/// bronze cursors as done-by-cap, clear any pause, and supersede any
/// pre-clamp realtime demand. Used both to cap a DAO's ongoing deep backfill
/// and to restart a previously-stopped one — restart never resumes old
/// cursor state, it always re-anchors fresh at the current head.
pub async fn clamp_account_to_head(
    pool: &PgPool,
    network: &NetworkConfig,
    http_client: &reqwest::Client,
    fastnear_api_key: &str,
    account_id: &str,
) -> Result<ClampSummary, ClampError> {
    let (block_height, block_time) = resolve_head_block(network).await?;
    let held_assets = discover_held_assets(
        pool,
        network,
        http_client,
        fastnear_api_key,
        account_id,
        block_height as u64,
    )
    .await?;

    let mut tx = pool.begin().await?;

    for held in &held_assets {
        sqlx::query(
            r#"
            DELETE FROM silver_balance_history
            WHERE account_id = $1 AND asset = $2 AND entry_kind = 'observation'
            "#,
        )
        .bind(account_id)
        .bind(held.asset.token_id())
        .execute(&mut *tx)
        .await?;

        let entry_key = format!(
            "observation:{account_id}:{}:{block_height}",
            held.asset.token_id()
        );
        sqlx::query(
            r#"
            INSERT INTO silver_balance_history (
                account_id, asset, token_standard, entry_kind, entry_key,
                source, source_event_id, receipt_id, transaction_hash, counterparty,
                block_height, block_time, intra_block_seq,
                delta_raw, delta, decimals, balance_before, balance_after,
                affects_user_balance, user_balance_after
            )
            VALUES (
                $1, $2, $3::public_token_standard, 'observation', $4,
                NULL, NULL, NULL, NULL, NULL,
                $5, $6, $7,
                0, 0, $8, $9, $9,
                TRUE, $9
            )
            "#,
        )
        .bind(account_id)
        .bind(held.asset.token_id())
        .bind(held.asset.token_standard().as_str())
        .bind(&entry_key)
        .bind(block_height)
        .bind(block_time)
        .bind(CLAMP_ANCHOR_INTRA_BLOCK_SEQ)
        .bind(held.decimals)
        .bind(&held.balance)
        .execute(&mut *tx)
        .await?;
    }

    // Mirror the anchors into the unified ledger immediately so charts see
    // them without waiting for an async gold projection cycle.
    sync_hidden_ledger_rows(&mut tx, account_id, block_time).await?;

    // Supersede demands at or before the anchor: their trigger transaction
    // is now older than where coverage starts, so replaying them would
    // either be redundant (already covered by the anchor) or unfindable
    // (see stop_history_ingestion's doc comment). Discovery above makes
    // several sequential RPC calls after resolving `block_height` — real
    // activity can land for the account during that window, and a demand
    // for it must survive: it's for a block after the anchor, so the normal
    // latest-lane dispatch is still the right (and only) path to ingest it.
    sqlx::query(
        "DELETE FROM public_history_latest_demands WHERE account_id = $1 AND trigger_block_height <= $2",
    )
    .bind(account_id)
    .bind(block_height)
    .execute(&mut *tx)
    .await?;

    for source in PublicHistorySource::all() {
        sqlx::query(
            r#"
            INSERT INTO bronze_public_history_cursors (
                account_id, source, backward_cursor, backfill_done,
                backfill_capped, capped_at_block_height, capped_at_time,
                last_seen_block_height, updated_at
            )
            VALUES ($1, $2::public_history_source, NULL, true, true, $3, $4, $3, NOW())
            ON CONFLICT (account_id, source) DO UPDATE SET
                backward_cursor = NULL,
                backfill_done = true,
                backfill_capped = true,
                capped_at_block_height = $3,
                capped_at_time = $4,
                last_seen_block_height = $3,
                updated_at = NOW()
            "#,
        )
        .bind(account_id)
        .bind(source.as_str())
        .bind(block_height)
        .bind(block_time)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        UPDATE monitored_accounts
        SET history_ingestion_paused_at = NULL, updated_at = NOW()
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(ClampSummary {
        block_height,
        assets_anchored: held_assets.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time signature guard for `dao_history_control.rs`, the
    /// gitignored operator entrypoint that's this module's only caller — CI
    /// builds this crate but never that script, so a breaking signature
    /// change here would otherwise go unnoticed until someone runs it.
    /// `#[ignore]` means this never actually executes (it would need a live
    /// DB and archival RPC); `cargo check --tests` / `cargo test --no-run`
    /// still have to compile it, which is the only thing this guards.
    #[allow(dead_code)]
    #[ignore]
    #[tokio::test]
    async fn signatures_match_the_operator_script()
    -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let pool = PgPool::connect("postgres://unused").await?;
        let network = NetworkConfig::mainnet();
        let http_client = reqwest::Client::new();

        stop_history_ingestion(&pool, "dao.sputnik-dao.near").await?;
        clamp_account_to_head(
            &pool,
            &network,
            &http_client,
            "unused",
            "dao.sputnik-dao.near",
        )
        .await?;
        Ok(())
    }
}
