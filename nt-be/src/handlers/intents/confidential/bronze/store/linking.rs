use sqlx::{PgPool, Postgres, Transaction};

use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty_for_history_event;

pub(super) async fn link_history_event_to_intent_tx(
    tx: &mut Transaction<'_, Postgres>,
    history_event_id: i64,
    account_id: &str,
    deposit_address: &str,
    recipient: Option<&str>,
) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        WITH candidate AS (
            SELECT id
            FROM confidential_intents
            WHERE dao_id = $2
              AND deposit_address = $3
              AND history_event_id IS NULL
              AND proposal_id IS NOT NULL
              AND status = 'submitted'
              AND NOT EXISTS (
                  SELECT 1
                  FROM confidential_intents existing
                  WHERE existing.history_event_id = $1
              )
              AND (
                  $4::TEXT IS NULL
                  OR $4 = quote_metadata->'quoteRequest'->>'recipient'
              )
        ),
        single_candidate AS (
            SELECT id
            FROM candidate
            WHERE (SELECT COUNT(*) FROM candidate) = 1
        )
        UPDATE confidential_intents ci
        SET history_event_id = $1,
            updated_at = NOW()
        FROM single_candidate sc
        WHERE ci.id = sc.id
        RETURNING ci.id
        "#,
    )
    .bind(history_event_id)
    .bind(account_id)
    .bind(deposit_address)
    .bind(recipient)
    .fetch_optional(&mut **tx)
    .await
}

pub async fn link_intent_to_history_event(
    pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let linked = sqlx::query_scalar(
        r#"
        WITH intent AS (
            SELECT
                id,
                dao_id,
                deposit_address,
                quote_metadata->'quoteRequest'->>'recipient' AS recipient
            FROM confidential_intents
            WHERE dao_id = $1
              AND payload_hash = $2
              AND history_event_id IS NULL
              AND proposal_id IS NOT NULL
              AND status = 'submitted'
              AND deposit_address IS NOT NULL
        ),
        candidate AS (
            SELECT he.id AS history_event_id
            FROM bronze_confidential_history_events he
            JOIN intent i
              ON he.account_id = i.dao_id
             AND he.deposit_address = i.deposit_address
             AND (
                 i.recipient IS NULL
                 OR he.recipient = i.recipient
             )
            WHERE NOT EXISTS (
                SELECT 1
                FROM confidential_intents existing
                WHERE existing.history_event_id = he.id
            )
        ),
        single_candidate AS (
            SELECT history_event_id
            FROM candidate
            WHERE (SELECT COUNT(*) FROM candidate) = 1
        )
        UPDATE confidential_intents ci
        SET history_event_id = sc.history_event_id,
            updated_at = NOW()
        FROM intent i, single_candidate sc
        WHERE ci.id = i.id
        RETURNING ci.history_event_id
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .fetch_optional(pool)
    .await?;

    if let Some(history_event_id) = linked {
        mark_gold_dirty_for_history_event(pool, history_event_id).await?;
        return Ok(Some(history_event_id));
    }

    Ok(None)
}
