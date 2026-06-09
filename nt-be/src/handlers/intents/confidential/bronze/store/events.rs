use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::linking::link_history_event_to_intent_tx;
use super::models::{
    HistoryEventUpsertOutcome, HistoryEventUpsertState, HistoryUpsertResult, min_datetime,
};
use crate::handlers::intents::confidential::bronze::api::HistoryEvent;
use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty_tx;
use crate::handlers::intents::confidential::types::bare_account;

pub async fn upsert_history_events(
    pool: &PgPool,
    account_id: &str,
    events: &[HistoryEvent],
) -> Result<HistoryUpsertResult, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut result = HistoryUpsertResult::default();

    for event in events {
        let item = &event.item;
        result.rows_touched += 1;

        let recipient = item.recipient.as_deref().map(bare_account);

        let changed_row = sqlx::query_as::<_, (i64, DateTime<Utc>, bool)>(
            r#"
            INSERT INTO bronze_confidential_history_events (
                account_id,
                created_at_external,
                deposit_address,
                deposit_memo,
                status,
                deposit_type,
                recipient_type,
                recipient,
                origin_asset,
                destination_asset,
                raw_payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (account_id, created_at_external, deposit_address) DO UPDATE SET
                deposit_memo = EXCLUDED.deposit_memo,
                status = EXCLUDED.status,
                deposit_type = EXCLUDED.deposit_type,
                recipient_type = EXCLUDED.recipient_type,
                recipient = EXCLUDED.recipient,
                origin_asset = EXCLUDED.origin_asset,
                destination_asset = EXCLUDED.destination_asset,
                raw_payload = EXCLUDED.raw_payload,
                updated_at = NOW()
            WHERE (
                bronze_confidential_history_events.deposit_memo,
                bronze_confidential_history_events.status,
                bronze_confidential_history_events.deposit_type,
                bronze_confidential_history_events.recipient_type,
                bronze_confidential_history_events.recipient,
                bronze_confidential_history_events.origin_asset,
                bronze_confidential_history_events.destination_asset,
                bronze_confidential_history_events.raw_payload
            ) IS DISTINCT FROM (
                EXCLUDED.deposit_memo,
                EXCLUDED.status,
                EXCLUDED.deposit_type,
                EXCLUDED.recipient_type,
                EXCLUDED.recipient,
                EXCLUDED.origin_asset,
                EXCLUDED.destination_asset,
                EXCLUDED.raw_payload
            )
            RETURNING id, created_at_external, xmax = 0 AS inserted
            "#,
        )
        .bind(account_id)
        .bind(item.created_at)
        .bind(&item.deposit_address)
        .bind(&item.deposit_memo)
        .bind(&item.status)
        .bind(&item.deposit_type)
        .bind(&item.recipient_type)
        .bind(&recipient)
        .bind(&item.origin_asset)
        .bind(&item.destination_asset)
        .bind(&event.raw_payload)
        .fetch_optional(&mut *tx)
        .await?;

        let (history_event_id, created_at_external, upsert_state) =
            if let Some((history_event_id, created_at_external, inserted)) = changed_row {
                if inserted {
                    result.rows_inserted += 1;
                    result.events.push(HistoryEventUpsertOutcome {
                        history_event_id,
                        created_at_external,
                        state: HistoryEventUpsertState::Inserted,
                    });
                } else {
                    result.rows_changed += 1;
                    result.events.push(HistoryEventUpsertOutcome {
                        history_event_id,
                        created_at_external,
                        state: HistoryEventUpsertState::Changed,
                    });
                }
                result.earliest_changed_at =
                    min_datetime(result.earliest_changed_at, Some(created_at_external));
                (
                    history_event_id,
                    created_at_external,
                    if inserted {
                        HistoryEventUpsertState::Inserted
                    } else {
                        HistoryEventUpsertState::Changed
                    },
                )
            } else {
                result.rows_unchanged += 1;
                let (history_event_id, created_at_external) =
                    sqlx::query_as::<_, (i64, DateTime<Utc>)>(
                        r#"
                        SELECT id, created_at_external
                        FROM bronze_confidential_history_events
                        WHERE account_id = $1
                          AND created_at_external = $2
                          AND deposit_address = $3
                        "#,
                    )
                    .bind(account_id)
                    .bind(item.created_at)
                    .bind(&item.deposit_address)
                    .fetch_one(&mut *tx)
                    .await?;
                result.events.push(HistoryEventUpsertOutcome {
                    history_event_id,
                    created_at_external,
                    state: HistoryEventUpsertState::Unchanged,
                });
                (
                    history_event_id,
                    created_at_external,
                    HistoryEventUpsertState::Unchanged,
                )
            };

        debug_assert_eq!(
            upsert_state,
            result
                .events
                .last()
                .map(|event| event.state)
                .unwrap_or(HistoryEventUpsertState::Unchanged)
        );

        let linked_intent_id = link_history_event_to_intent_tx(
            &mut tx,
            history_event_id,
            account_id,
            &item.deposit_address,
            recipient.as_deref(),
        )
        .await?;

        if let Some(intent_id) = linked_intent_id {
            result.links_created += 1;
            result.earliest_changed_at =
                min_datetime(result.earliest_changed_at, Some(created_at_external));
            tracing::info!(
                "linked history_event_id={} to confidential_intent_id={}",
                history_event_id,
                intent_id
            );
        }
    }

    if result.earliest_changed_at.is_some() {
        mark_gold_dirty_tx(&mut tx, account_id, result.earliest_changed_at).await?;
    }

    tx.commit().await?;
    Ok(result)
}
