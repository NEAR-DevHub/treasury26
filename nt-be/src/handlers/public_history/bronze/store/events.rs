use sqlx::PgPool;

use super::models::{BronzePublicHistoryEvent, PublicHistoryUpsertResult, min_datetime};
use crate::handlers::public_history::silver::cursors::mark_silver_dirty_tx;

pub async fn upsert_public_history_events(
    pool: &PgPool,
    events: &[BronzePublicHistoryEvent],
) -> Result<PublicHistoryUpsertResult, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut result = PublicHistoryUpsertResult::default();

    for event in events {
        result.rows_touched += 1;

        let changed_row = sqlx::query_as::<_, (i64, chrono::DateTime<chrono::Utc>, bool)>(
            r#"
            INSERT INTO bronze_public_history_events (
                account_id,
                source,
                source_event_key,
                transaction_hash,
                receipt_id,
                event_index,
                block_height,
                block_timestamp,
                block_time,
                affected_account_id,
                involved_account_id,
                contract_account_id,
                token_id,
                cause,
                action_kind,
                method_name,
                delta_amount_raw,
                decimals,
                deposit_raw,
                outcome_status,
                raw_payload
            )
            VALUES (
                $1, $2::public_history_source, $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                $19, $20, $21
            )
            ON CONFLICT (source, source_event_key) DO UPDATE SET
                account_id = EXCLUDED.account_id,
                transaction_hash = EXCLUDED.transaction_hash,
                receipt_id = EXCLUDED.receipt_id,
                event_index = EXCLUDED.event_index,
                block_height = EXCLUDED.block_height,
                block_timestamp = EXCLUDED.block_timestamp,
                block_time = EXCLUDED.block_time,
                affected_account_id = EXCLUDED.affected_account_id,
                involved_account_id = EXCLUDED.involved_account_id,
                contract_account_id = EXCLUDED.contract_account_id,
                token_id = EXCLUDED.token_id,
                cause = EXCLUDED.cause,
                action_kind = EXCLUDED.action_kind,
                method_name = EXCLUDED.method_name,
                delta_amount_raw = EXCLUDED.delta_amount_raw,
                decimals = EXCLUDED.decimals,
                deposit_raw = EXCLUDED.deposit_raw,
                outcome_status = EXCLUDED.outcome_status,
                raw_payload = EXCLUDED.raw_payload,
                updated_at = NOW()
            WHERE (
                bronze_public_history_events.account_id,
                bronze_public_history_events.transaction_hash,
                bronze_public_history_events.receipt_id,
                bronze_public_history_events.event_index,
                bronze_public_history_events.block_height,
                bronze_public_history_events.block_timestamp,
                bronze_public_history_events.block_time,
                bronze_public_history_events.affected_account_id,
                bronze_public_history_events.involved_account_id,
                bronze_public_history_events.contract_account_id,
                bronze_public_history_events.token_id,
                bronze_public_history_events.cause,
                bronze_public_history_events.action_kind,
                bronze_public_history_events.method_name,
                bronze_public_history_events.delta_amount_raw,
                bronze_public_history_events.decimals,
                bronze_public_history_events.deposit_raw,
                bronze_public_history_events.outcome_status,
                bronze_public_history_events.raw_payload
            ) IS DISTINCT FROM (
                EXCLUDED.account_id,
                EXCLUDED.transaction_hash,
                EXCLUDED.receipt_id,
                EXCLUDED.event_index,
                EXCLUDED.block_height,
                EXCLUDED.block_timestamp,
                EXCLUDED.block_time,
                EXCLUDED.affected_account_id,
                EXCLUDED.involved_account_id,
                EXCLUDED.contract_account_id,
                EXCLUDED.token_id,
                EXCLUDED.cause,
                EXCLUDED.action_kind,
                EXCLUDED.method_name,
                EXCLUDED.delta_amount_raw,
                EXCLUDED.decimals,
                EXCLUDED.deposit_raw,
                EXCLUDED.outcome_status,
                EXCLUDED.raw_payload
            )
            RETURNING id, block_time, xmax = 0 AS inserted
            "#,
        )
        .bind(&event.account_id)
        .bind(event.source.as_str())
        .bind(&event.source_event_key)
        .bind(&event.transaction_hash)
        .bind(&event.receipt_id)
        .bind(event.event_index)
        .bind(event.block_height)
        .bind(&event.block_timestamp)
        .bind(event.block_time)
        .bind(&event.affected_account_id)
        .bind(&event.involved_account_id)
        .bind(&event.contract_account_id)
        .bind(&event.token_id)
        .bind(&event.cause)
        .bind(&event.action_kind)
        .bind(&event.method_name)
        .bind(&event.delta_amount_raw)
        .bind(event.decimals)
        .bind(&event.deposit_raw)
        .bind(event.outcome_status)
        .bind(&event.raw_payload)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some((_id, block_time, inserted)) = changed_row {
            if inserted {
                result.rows_inserted += 1;
            } else {
                result.rows_changed += 1;
            }
            // Reproject from the earliest changed source event; later silver/gold
            // stages delete stale derived rows beyond that point.
            result.earliest_changed_at = min_datetime(result.earliest_changed_at, Some(block_time));
        } else {
            result.rows_unchanged += 1;
        }
    }

    if let Some(recompute_from) = result.earliest_changed_at
        && let Some(account_id) = events.first().map(|event| event.account_id.as_str())
    {
        mark_silver_dirty_tx(&mut tx, account_id, Some(recompute_from)).await?;
    }

    tx.commit().await?;
    Ok(result)
}
