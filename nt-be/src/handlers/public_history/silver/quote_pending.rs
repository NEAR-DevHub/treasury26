use std::str::FromStr;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Postgres, Transaction};

use super::models::{
    NormalizedTransferLeg, ProposalLink, PublicAmount, PublicAsset, PublicTransferDirection,
    PublicTransferLegKind,
};
use crate::handlers::public_history::bronze::store::PublicHistorySource;
use crate::handlers::public_history::quotes::{
    QUOTE_LEG_MATCH_SQL, QuoteProposalSnapshot, proposal_quote_from_metadata,
};

#[derive(Debug, sqlx::FromRow)]
struct QuotePendingProposal {
    proposal_ref: i64,
    dao_id: String,
    proposal_id: i64,
    quote_metadata: Value,
    proposal_executed_at: DateTime<Utc>,
    block_height: i64,
    transaction_hash: Option<String>,
}

async fn load_quote_pending_proposals(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<QuotePendingProposal>, sqlx::Error> {
    let sql = format!(
        r#"
        SELECT
            dp.id AS proposal_ref,
            dp.dao_id,
            dp.proposal_id,
            dp.quote_metadata,
            dp.proposal_executed_at,
            COALESCE(dp.proposal_execution_block_height, 0) AS block_height,
            dp.proposal_execution_transaction_hash AS transaction_hash
        FROM dao_proposals dp
        WHERE dp.dao_id = $1
          AND dp.proposal_executed_at IS NOT NULL
          AND dp.proposal_executed_at >= $2
          AND dp.quote_deposit_address IS NOT NULL
          AND dp.quote_metadata->'proposalQuote' IS NOT NULL
          AND dp.quote_metadata->'proposalQuote'->>'originAmountRaw' ~ '^[0-9]+(\.[0-9]+)?$'
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_transfer_legs l
              WHERE {QUOTE_LEG_MATCH_SQL}
          )
        ORDER BY dp.proposal_executed_at ASC, dp.id ASC
        "#
    );
    sqlx::query_as::<_, QuotePendingProposal>(&sql)
        .bind(account_id)
        .bind(recompute_from)
        .fetch_all(&mut **tx)
        .await
}

fn quote_asset_to_public_asset(origin_asset: &str) -> PublicAsset {
    let origin_asset = origin_asset.trim();
    if origin_asset.eq_ignore_ascii_case("near") {
        return PublicAsset::native_near();
    }
    if origin_asset.starts_with("intents.near:") {
        return PublicAsset::nep245(origin_asset);
    }
    if let Some(contract) = origin_asset.strip_prefix("nep141:") {
        return PublicAsset::nep141(contract);
    }
    PublicAsset::nep141(origin_asset)
}

fn token_decimal_lookup_ids(origin_asset: &str) -> Vec<String> {
    let origin_asset = origin_asset.trim();
    if origin_asset.eq_ignore_ascii_case("near") {
        return Vec::new();
    }
    if let Some(stripped) = origin_asset.strip_prefix("intents.near:") {
        return vec![stripped.to_string(), origin_asset.to_string()];
    }
    if origin_asset.starts_with("nep141:") || origin_asset.starts_with("nep245:") {
        return vec![origin_asset.to_string()];
    }
    vec![format!("nep141:{origin_asset}"), origin_asset.to_string()]
}

async fn resolve_quote_decimals(
    tx: &mut Transaction<'_, Postgres>,
    origin_asset: &str,
) -> Result<Option<i32>, sqlx::Error> {
    if origin_asset.eq_ignore_ascii_case("near") {
        return Ok(Some(24));
    }
    if matches!(
        origin_asset,
        "nep141:wrap.near" | "intents.near:nep141:wrap.near" | "wrap.near"
    ) {
        return Ok(Some(24));
    }

    let lookup_ids = token_decimal_lookup_ids(origin_asset);
    if lookup_ids.is_empty() {
        return Ok(None);
    }

    let decimals: Option<i16> = sqlx::query_scalar(
        r#"
        SELECT decimals
        FROM tokens
        WHERE token_id = ANY($1::text[])
        LIMIT 1
        "#,
    )
    .bind(&lookup_ids)
    .fetch_optional(&mut **tx)
    .await?;

    Ok(decimals.map(i32::from))
}

async fn pending_leg_from_proposal(
    tx: &mut Transaction<'_, Postgres>,
    row: QuotePendingProposal,
) -> Result<Option<NormalizedTransferLeg>, sqlx::Error> {
    let Some(quote) = proposal_quote_from_metadata(Some(&row.quote_metadata)) else {
        return Ok(None);
    };
    let Some(decimals) = resolve_quote_decimals(tx, &quote.origin_asset).await? else {
        tracing::warn!(
            dao_id = row.dao_id,
            proposal_id = row.proposal_id,
            origin_asset = quote.origin_asset,
            "skipping quote pending leg because token decimals are unavailable"
        );
        return Ok(None);
    };
    let Ok(amount_raw) = BigDecimal::from_str(&quote.origin_amount_raw) else {
        return Ok(None);
    };

    Ok(Some(build_pending_leg(row, quote, amount_raw, decimals)))
}

fn build_pending_leg(
    row: QuotePendingProposal,
    quote: QuoteProposalSnapshot,
    amount_raw: BigDecimal,
    decimals: i32,
) -> NormalizedTransferLeg {
    NormalizedTransferLeg {
        account_id: row.dao_id.clone(),
        leg_key: format!("quote_projection:{}", row.proposal_ref),
        source_event_id: None,
        source: PublicHistorySource::QuoteProjection,
        proposal_link: Some(ProposalLink {
            proposal_ref: row.proposal_ref,
            proposal_id: row.proposal_id,
        }),
        transaction_hash: row.transaction_hash,
        receipt_id: None,
        block_height: row.block_height,
        block_time: row.proposal_executed_at,
        asset: quote_asset_to_public_asset(&quote.origin_asset),
        direction: PublicTransferDirection::Outgoing,
        counterparty: Some(quote.deposit_address.clone()),
        amount: PublicAmount::from_raw(amount_raw, decimals),
        leg_kind: PublicTransferLegKind::QuotePending,
        raw_payload: serde_json::json!({
            "classification": "quote_pending_synthetic",
            "quote_metadata": row.quote_metadata,
        }),
    }
}

pub async fn build_quote_pending_legs(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<NormalizedTransferLeg>, sqlx::Error> {
    let proposals = load_quote_pending_proposals(tx, account_id, recompute_from).await?;
    let mut legs = Vec::new();
    for proposal in proposals {
        if let Some(leg) = pending_leg_from_proposal(tx, proposal).await? {
            legs.push(leg);
        }
    }
    Ok(legs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_asset_to_public_asset_preserves_intents_token_id() {
        let asset = quote_asset_to_public_asset("intents.near:nep141:usdc.near");
        assert_eq!(asset.token_id(), "intents.near:nep141:usdc.near");
    }

    #[test]
    fn quote_asset_to_public_asset_strips_nep141_for_near_ft() {
        let asset = quote_asset_to_public_asset("nep141:usdc.near");
        assert_eq!(asset.token_id(), "usdc.near");
    }
}
