use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{BronzePublicHistoryRow, DirtyPublicHistoryAccount, NormalizedTransferLeg};
use crate::handlers::public_history::gold::cursors::mark_gold_dirty_tx;

pub async fn load_dirty_accounts(
    pool: &PgPool,
) -> Result<Vec<DirtyPublicHistoryAccount>, sqlx::Error> {
    sqlx::query_as::<_, DirtyPublicHistoryAccount>(
        r#"
        SELECT
            account_id,
            silver_dirty_since AS dirty_since,
            silver_recompute_from AS recompute_from
        FROM silver_public_history_cursors
        WHERE silver_dirty_since IS NOT NULL
        ORDER BY silver_dirty_since ASC, account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn earliest_bronze_time(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(block_time)
        FROM bronze_public_history_events
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
}

pub async fn has_silver_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM silver_public_transfer_legs
            WHERE account_id = $1
              AND block_time < $2
        )
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

pub async fn load_bronze_suffix(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<BronzePublicHistoryRow>, sqlx::Error> {
    sqlx::query_as::<_, BronzePublicHistoryRow>(
        r#"
        SELECT
            b.id,
            b.account_id,
            b.source::text AS source,
            b.source_event_key,
            b.transaction_hash,
            b.receipt_id,
            b.event_index,
            b.block_height,
            b.block_timestamp,
            b.block_time,
            b.affected_account_id,
            b.involved_account_id,
            b.contract_account_id,
            b.token_id,
            b.cause,
            b.action_kind,
            b.method_name,
            b.delta_amount_raw,
            b.decimals,
            b.deposit_raw,
            b.outcome_status,
            b.raw_payload,
            dp.id AS proposal_ref,
            dp.proposal_id
        FROM bronze_public_history_events b
        -- Batched act_proposal calls can execute multiple proposals in one tx.
        -- Link only unambiguous matches; otherwise leave proposal_ref null.
        LEFT JOIN LATERAL (
            SELECT matched.id, matched.proposal_id
            FROM (
                SELECT
                    dp.id,
                    dp.proposal_id,
                    COUNT(*) OVER () AS match_count
                FROM dao_proposals dp
                WHERE dp.dao_id = b.account_id
                  AND dp.proposal_execution_transaction_hash = b.transaction_hash
            ) matched
            WHERE matched.match_count = 1
        ) dp ON TRUE
        WHERE b.account_id = $1
          AND b.block_time >= $2
        ORDER BY b.block_time ASC, b.block_height ASC, b.id ASC
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

pub async fn upsert_silver_legs(
    tx: &mut Transaction<'_, Postgres>,
    legs: &[NormalizedTransferLeg],
) -> Result<u64, sqlx::Error> {
    if legs.is_empty() {
        return Ok(0);
    }

    let account_ids: Vec<&str> = legs.iter().map(|leg| leg.account_id.as_str()).collect();
    let leg_keys: Vec<&str> = legs.iter().map(|leg| leg.leg_key.as_str()).collect();
    let source_event_ids: Vec<i64> = legs.iter().map(|leg| leg.source_event_id).collect();
    let sources: Vec<&str> = legs.iter().map(|leg| leg.source.as_str()).collect();
    let proposal_refs: Vec<Option<i64>> = legs
        .iter()
        .map(|leg| leg.proposal_link.as_ref().map(|link| link.proposal_ref))
        .collect();
    let proposal_ids: Vec<Option<i64>> = legs
        .iter()
        .map(|leg| leg.proposal_link.as_ref().map(|link| link.proposal_id))
        .collect();
    let transaction_hashes: Vec<Option<&str>> = legs
        .iter()
        .map(|leg| leg.transaction_hash.as_deref())
        .collect();
    let receipt_ids: Vec<Option<&str>> = legs.iter().map(|leg| leg.receipt_id.as_deref()).collect();
    let block_heights: Vec<i64> = legs.iter().map(|leg| leg.block_height).collect();
    let block_times: Vec<DateTime<Utc>> = legs.iter().map(|leg| leg.block_time).collect();
    let token_standards: Vec<&str> = legs
        .iter()
        .map(|leg| leg.asset.token_standard().as_str())
        .collect();
    let token_ids: Vec<&str> = legs.iter().map(|leg| leg.asset.token_id()).collect();
    let directions: Vec<&str> = legs.iter().map(|leg| leg.direction.as_str()).collect();
    let counterparties: Vec<Option<&str>> =
        legs.iter().map(|leg| leg.counterparty.as_deref()).collect();
    let amount_raws = legs
        .iter()
        .map(|leg| leg.amount.raw.clone())
        .collect::<Vec<_>>();
    let amounts = legs
        .iter()
        .map(|leg| leg.amount.amount.clone())
        .collect::<Vec<_>>();
    let decimals: Vec<i32> = legs.iter().map(|leg| leg.amount.decimals).collect();
    let leg_kinds: Vec<&str> = legs.iter().map(|leg| leg.leg_kind.as_str()).collect();
    let raw_payloads: Vec<Value> = legs.iter().map(|leg| leg.raw_payload.clone()).collect();

    let result = sqlx::query(
        r#"
        INSERT INTO silver_public_transfer_legs (
            account_id,
            leg_key,
            source_event_id,
            source,
            proposal_ref,
            proposal_id,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            raw_payload
        )
        SELECT
            account_id,
            leg_key,
            source_event_id,
            source::public_history_source,
            proposal_ref,
            proposal_id,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard::public_token_standard,
            token_id,
            direction::public_transfer_direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind::public_transfer_leg_kind,
            raw_payload
        FROM UNNEST(
            $1::text[],
            $2::text[],
            $3::bigint[],
            $4::text[],
            $5::bigint[],
            $6::bigint[],
            $7::text[],
            $8::text[],
            $9::bigint[],
            $10::timestamptz[],
            $11::text[],
            $12::text[],
            $13::text[],
            $14::text[],
            $15::numeric[],
            $16::numeric[],
            $17::integer[],
            $18::text[],
            $19::jsonb[]
        ) AS t(
            account_id,
            leg_key,
            source_event_id,
            source,
            proposal_ref,
            proposal_id,
            transaction_hash,
            receipt_id,
            block_height,
            block_time,
            token_standard,
            token_id,
            direction,
            counterparty,
            amount_raw,
            amount,
            decimals,
            leg_kind,
            raw_payload
        )
        ON CONFLICT (leg_key) DO UPDATE SET
            source_event_id = EXCLUDED.source_event_id,
            source = EXCLUDED.source,
            proposal_ref = EXCLUDED.proposal_ref,
            proposal_id = EXCLUDED.proposal_id,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            block_height = EXCLUDED.block_height,
            block_time = EXCLUDED.block_time,
            token_standard = EXCLUDED.token_standard,
            token_id = EXCLUDED.token_id,
            direction = EXCLUDED.direction,
            counterparty = EXCLUDED.counterparty,
            amount_raw = EXCLUDED.amount_raw,
            amount = EXCLUDED.amount,
            decimals = EXCLUDED.decimals,
            leg_kind = EXCLUDED.leg_kind,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(&account_ids)
    .bind(&leg_keys)
    .bind(&source_event_ids)
    .bind(&sources)
    .bind(&proposal_refs)
    .bind(&proposal_ids)
    .bind(&transaction_hashes)
    .bind(&receipt_ids)
    .bind(&block_heights)
    .bind(&block_times)
    .bind(&token_standards)
    .bind(&token_ids)
    .bind(&directions)
    .bind(&counterparties)
    .bind(&amount_raws)
    .bind(&amounts)
    .bind(&decimals)
    .bind(&leg_kinds)
    .bind(&raw_payloads)
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected())
}

pub async fn upsert_projection_errors(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    errors: &[(i64, String, Value)],
) -> Result<u64, sqlx::Error> {
    if errors.is_empty() {
        return Ok(0);
    }

    let source_event_ids: Vec<i64> = errors.iter().map(|(id, _, _)| *id).collect();
    let reasons: Vec<&str> = errors
        .iter()
        .map(|(_, reason, _)| reason.as_str())
        .collect();
    let raw_payloads: Vec<Value> = errors
        .iter()
        .map(|(_, _, raw_payload)| raw_payload.clone())
        .collect();

    let result = sqlx::query(
        r#"
        INSERT INTO silver_public_history_projection_errors (
            source_event_id,
            account_id,
            reason,
            raw_payload
        )
        SELECT source_event_id, $2, reason, raw_payload
        FROM UNNEST($1::bigint[], $3::text[], $4::jsonb[])
            AS t(source_event_id, reason, raw_payload)
        ON CONFLICT (source_event_id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            reason = EXCLUDED.reason,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(&source_event_ids)
    .bind(account_id)
    .bind(&reasons)
    .bind(&raw_payloads)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

pub async fn clear_projection_errors(
    tx: &mut Transaction<'_, Postgres>,
    source_event_ids: &[i64],
) -> Result<u64, sqlx::Error> {
    if source_event_ids.is_empty() {
        return Ok(0);
    }

    let result = sqlx::query(
        r#"
        DELETE FROM silver_public_history_projection_errors
        WHERE source_event_id = ANY($1::bigint[])
        "#,
    )
    .bind(source_event_ids)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

pub async fn delete_stale_silver_rows(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_leg_keys: &[String],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM silver_public_transfer_legs
        WHERE account_id = $1
          AND block_time >= $2
          AND NOT (leg_key = ANY($3))
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .bind(preserve_leg_keys)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

pub async fn mark_gold_dirty_for_silver_change(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    mark_gold_dirty_tx(tx, account_id, recompute_from).await
}
