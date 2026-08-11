use std::collections::HashMap;

use sqlx::PgPool;

use super::models::{BronzePublicHistoryEvent, PublicHistoryUpsertResult, min_datetime};
use crate::handlers::public_history::silver::cursors::mark_silver_dirty_tx;

/// One page-level multi-row upsert instead of a statement per event.
/// Duplicate (source, source_event_key) rows within a page are deduped
/// last-write-wins before building the statement — `ON CONFLICT DO UPDATE`
/// cannot touch the same row twice in one command.
pub async fn upsert_public_history_events(
    pool: &PgPool,
    events: &[BronzePublicHistoryEvent],
) -> Result<PublicHistoryUpsertResult, sqlx::Error> {
    let mut result = PublicHistoryUpsertResult {
        rows_touched: events.len() as u64,
        ..Default::default()
    };
    if events.is_empty() {
        return Ok(result);
    }

    let mut deduped: HashMap<(&str, &str), &BronzePublicHistoryEvent> = HashMap::new();
    for event in events {
        deduped.insert(
            (event.source.as_str(), event.source_event_key.as_str()),
            event,
        );
    }
    let deduped: Vec<&BronzePublicHistoryEvent> = deduped.into_values().collect();

    let mut tx = pool.begin().await?;

    let mut builder = sqlx::QueryBuilder::<sqlx::Postgres>::new(
        r#"INSERT INTO bronze_public_history_events (
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
        ) "#,
    );
    builder.push_values(deduped.iter(), |mut row, event| {
        row.push_bind(&event.account_id);
        row.push_bind(event.source.as_str());
        row.push_unseparated("::public_history_source");
        row.push_bind(&event.source_event_key);
        row.push_bind(&event.transaction_hash);
        row.push_bind(&event.receipt_id);
        row.push_bind(event.event_index);
        row.push_bind(event.block_height);
        row.push_bind(&event.block_timestamp);
        row.push_bind(event.block_time);
        row.push_bind(&event.affected_account_id);
        row.push_bind(&event.involved_account_id);
        row.push_bind(&event.contract_account_id);
        row.push_bind(&event.token_id);
        row.push_bind(&event.cause);
        row.push_bind(&event.action_kind);
        row.push_bind(&event.method_name);
        row.push_bind(&event.delta_amount_raw);
        row.push_bind(event.decimals);
        row.push_bind(&event.deposit_raw);
        row.push_bind(event.outcome_status);
        row.push_bind(&event.raw_payload);
    });
    builder.push(
        r#"
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
            RETURNING block_time, xmax = 0 AS inserted
        "#,
    );

    let changed_rows: Vec<(chrono::DateTime<chrono::Utc>, bool)> = builder
        .build_query_as()
        .fetch_all(&mut *tx)
        .await?;

    for (block_time, inserted) in &changed_rows {
        if *inserted {
            result.rows_inserted += 1;
        } else {
            result.rows_changed += 1;
        }
        // Reproject from the earliest changed source event; later silver/gold
        // stages delete stale derived rows beyond that point.
        result.earliest_changed_at = min_datetime(result.earliest_changed_at, Some(*block_time));
    }
    result.rows_unchanged = (deduped.len() as u64)
        .saturating_sub(result.rows_inserted)
        .saturating_sub(result.rows_changed);

    if let Some(recompute_from) = result.earliest_changed_at
        && let Some(account_id) = events.first().map(|event| event.account_id.as_str())
    {
        mark_silver_dirty_tx(&mut tx, account_id, Some(recompute_from)).await?;
    }

    tx.commit().await?;
    Ok(result)
}
