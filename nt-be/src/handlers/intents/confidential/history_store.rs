//! Postgres storage helpers for confidential history ingestion.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use super::history::HistoryEvent;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HistoryCursor {
    pub account_id: String,
    pub forward_cursor: Option<String>,
    pub backward_cursor: Option<String>,
    pub backfill_done: bool,
    pub next_poll_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
}

pub async fn upsert_history_events(
    pool: &PgPool,
    account_id: &str,
    events: &[HistoryEvent],
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut rows_touched = 0;

    for event in events {
        let item = &event.item;
        let row = sqlx::query_as::<_, (i64,)>(
            r#"
            INSERT INTO confidential_history_events (
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
            RETURNING id
            "#,
        )
        .bind(account_id)
        .bind(item.created_at)
        .bind(&item.deposit_address)
        .bind(&item.deposit_memo)
        .bind(&item.status)
        .bind(&item.deposit_type)
        .bind(&item.recipient_type)
        .bind(&item.recipient)
        .bind(&item.origin_asset)
        .bind(&item.destination_asset)
        .bind(&event.raw_payload)
        .fetch_one(&mut *tx)
        .await?;

        let history_event_id = row.0;
        let linked_intent_id = link_history_event_to_intent_tx(
            &mut tx,
            history_event_id,
            account_id,
            &item.deposit_address,
            item.recipient.as_deref(),
        )
        .await?;

        if let Some(intent_id) = linked_intent_id {
            log::info!(
                "[confidential-history] linked history_event_id={} to confidential_intent_id={}",
                history_event_id,
                intent_id
            );
        }

        rows_touched += 1;
    }

    tx.commit().await?;
    Ok(rows_touched)
}

async fn link_history_event_to_intent_tx(
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
                  OR quote_metadata->'quoteRequest'->>'recipient' = $4
                  OR quote_metadata->'quoteRequest'->>'recipient' = CONCAT('near:', $4)
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
    sqlx::query_scalar(
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
            FROM confidential_history_events he
            JOIN intent i
              ON he.account_id = i.dao_id
             AND he.deposit_address = i.deposit_address
             AND (
                 i.recipient IS NULL
                 OR he.recipient = i.recipient
                 OR CONCAT('near:', he.recipient) = i.recipient
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
    .await
}

pub async fn load_history_cursor(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<HistoryCursor>, sqlx::Error> {
    sqlx::query_as::<_, HistoryCursor>(
        r#"
        SELECT
            account_id,
            forward_cursor,
            backward_cursor,
            backfill_done,
            next_poll_at,
            last_polled_at
        FROM confidential_history_cursors
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

pub async fn save_history_cursors(
    pool: &PgPool,
    account_id: &str,
    forward_cursor: Option<&str>,
    backward_cursor: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO confidential_history_cursors (
            account_id,
            forward_cursor,
            backward_cursor,
            last_polled_at,
            updated_at
        )
        VALUES ($1, $2, $3, NOW(), NOW())
        ON CONFLICT (account_id) DO UPDATE SET
            forward_cursor = COALESCE(
                EXCLUDED.forward_cursor,
                confidential_history_cursors.forward_cursor
            ),
            backward_cursor = COALESCE(
                EXCLUDED.backward_cursor,
                confidential_history_cursors.backward_cursor
            ),
            last_polled_at = NOW(),
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(forward_cursor)
    .bind(backward_cursor)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn mark_history_backfill_done(
    pool: &PgPool,
    account_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO confidential_history_cursors (
            account_id,
            backfill_done,
            updated_at
        )
        VALUES ($1, true, NOW())
        ON CONFLICT (account_id) DO UPDATE SET
            backfill_done = true,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn load_confidential_history_accounts(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM monitored_accounts
        WHERE enabled = true
          AND is_confidential_account = true
        ORDER BY account_id
        "#,
    )
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::intents::confidential::history::{HistoryEvent, HistoryItem};
    use crate::utils::env::EnvVars;

    fn sample_history_event() -> HistoryEvent {
        let raw_payload = serde_json::json!({
            "amountInFormatted": "0.1",
            "amountInUsd": "0.1580",
            "amountOutFormatted": "0.157798",
            "amountOutUsd": "0.1578",
            "createdAt": "2026-05-12T09:32:09.214593Z",
            "depositAddress": "217207ee593800d1d536d69a6f8d7b175792ad3a9a744f8b2ef1f1585651f47d",
            "depositMemo": null,
            "depositType": "CONFIDENTIAL_INTENTS",
            "destinationAsset": "nep141:wrap.near",
            "originAsset": "nep141:wrap.near",
            "recipient": "tobi.sputnik-dao.near",
            "recipientType": "CONFIDENTIAL_INTENTS",
            "refundFee": "0",
            "status": "SUCCESS"
        });
        let item = serde_json::from_value::<HistoryItem>(raw_payload.clone())
            .expect("sample item should parse");

        HistoryEvent { item, raw_payload }
    }

    async fn test_pool() -> PgPool {
        dotenvy::from_filename(".env").ok();
        dotenvy::from_filename(".env.test").ok();

        let env_vars = EnvVars::default();
        sqlx::postgres::PgPool::connect(&env_vars.database_url)
            .await
            .expect("Failed to connect to database")
    }

    #[tokio::test]
    #[ignore]
    async fn test_upsert_history_events_is_idempotent() {
        let pool = test_pool().await;
        let event = sample_history_event();
        let account_id = format!(
            "test-confidential-history-{}-dao.near",
            uuid::Uuid::new_v4()
        );

        let first_touched = upsert_history_events(&pool, &account_id, &[event.clone()])
            .await
            .expect("first upsert should succeed");
        let second_touched = upsert_history_events(&pool, &account_id, &[event.clone()])
            .await
            .expect("second upsert should succeed");

        let row_count: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*)
            FROM confidential_history_events
            WHERE account_id = $1
              AND created_at_external = $2
              AND deposit_address = $3
            "#,
        )
        .bind(&account_id)
        .bind(event.item.created_at)
        .bind(&event.item.deposit_address)
        .fetch_one(&pool)
        .await
        .expect("count query should succeed");

        assert_eq!(first_touched, 1);
        assert_eq!(second_touched, 1);
        assert_eq!(row_count, 1);
    }

    #[tokio::test]
    #[ignore]
    async fn test_save_history_cursors_does_not_overwrite_with_null() {
        let pool = test_pool().await;
        let account_id = format!("test-confidential-cursor-{}-dao.near", uuid::Uuid::new_v4());

        save_history_cursors(&pool, &account_id, Some("forward-1"), Some("backward-1"))
            .await
            .expect("initial cursor save should succeed");
        save_history_cursors(&pool, &account_id, None, Some("backward-2"))
            .await
            .expect("partial cursor save should succeed");

        let cursor = load_history_cursor(&pool, &account_id)
            .await
            .expect("cursor load should succeed")
            .expect("cursor row should exist");

        assert_eq!(cursor.forward_cursor.as_deref(), Some("forward-1"));
        assert_eq!(cursor.backward_cursor.as_deref(), Some("backward-2"));
        assert!(!cursor.backfill_done);
        assert!(cursor.last_polled_at.is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn test_mark_history_backfill_done() {
        let pool = test_pool().await;
        let account_id = format!(
            "test-confidential-backfill-done-{}-dao.near",
            uuid::Uuid::new_v4()
        );

        save_history_cursors(&pool, &account_id, Some("forward-1"), Some("backward-1"))
            .await
            .expect("cursor save should succeed");
        mark_history_backfill_done(&pool, &account_id)
            .await
            .expect("mark done should succeed");

        let cursor = load_history_cursor(&pool, &account_id)
            .await
            .expect("cursor load should succeed")
            .expect("cursor row should exist");

        assert!(cursor.backfill_done);
        assert_eq!(cursor.forward_cursor.as_deref(), Some("forward-1"));
        assert_eq!(cursor.backward_cursor.as_deref(), Some("backward-1"));
    }

    #[tokio::test]
    #[ignore]
    async fn test_load_confidential_history_accounts_filters_enabled_confidential() {
        let pool = test_pool().await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let enabled_confidential = format!("test-{}-a.near", &suffix[..8]);
        let disabled_confidential = format!("test-{}-b.near", &suffix[..8]);
        let enabled_public = format!("test-{}-c.near", &suffix[..8]);

        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
            VALUES
                ($1, true, true),
                ($2, false, true),
                ($3, true, false)
            ON CONFLICT (account_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                is_confidential_account = EXCLUDED.is_confidential_account
            "#,
        )
        .bind(&enabled_confidential)
        .bind(&disabled_confidential)
        .bind(&enabled_public)
        .execute(&pool)
        .await
        .expect("test monitored accounts should insert");

        let accounts = load_confidential_history_accounts(&pool)
            .await
            .expect("account load should succeed");

        assert!(accounts.contains(&enabled_confidential));
        assert!(!accounts.contains(&disabled_confidential));
        assert!(!accounts.contains(&enabled_public));
    }

    #[tokio::test]
    #[ignore]
    async fn test_link_intent_to_history_event_requires_submitted_proposal() {
        let pool = test_pool().await;
        let mut event = sample_history_event();
        let account_id = format!("test-confidential-link-{}-dao.near", uuid::Uuid::new_v4());
        let payload_hash = uuid::Uuid::new_v4().simple().to_string();

        event.item.recipient = Some(account_id.clone());
        if let serde_json::Value::Object(ref mut raw) = event.raw_payload {
            raw.insert(
                "recipient".to_string(),
                serde_json::Value::String(account_id.clone()),
            );
        }

        upsert_history_events(&pool, &account_id, &[event.clone()])
            .await
            .expect("Bronze upsert should succeed");

        let quote_metadata = serde_json::json!({
            "quote": {
                "depositAddress": event.item.deposit_address
            },
            "quoteRequest": {
                "recipient": format!("near:{}", account_id)
            }
        });

        sqlx::query(
            r#"
            INSERT INTO confidential_intents (
                dao_id,
                payload_hash,
                intent_payload,
                quote_metadata,
                deposit_address,
                status
            )
            VALUES ($1, $2, $3, $4, $5, 'submitted')
            "#,
        )
        .bind(&account_id)
        .bind(&payload_hash)
        .bind(serde_json::json!({ "message": "test" }))
        .bind(&quote_metadata)
        .bind(&event.item.deposit_address)
        .execute(&pool)
        .await
        .expect("intent insert should succeed");

        let blocked = link_intent_to_history_event(&pool, &account_id, &payload_hash)
            .await
            .expect("link attempt should succeed");
        assert!(blocked.is_none(), "proposal_id is required before linking");

        sqlx::query(
            r#"
            UPDATE confidential_intents
            SET proposal_id = 1
            WHERE dao_id = $1
              AND payload_hash = $2
            "#,
        )
        .bind(&account_id)
        .bind(&payload_hash)
        .execute(&pool)
        .await
        .expect("proposal update should succeed");

        let linked = link_intent_to_history_event(&pool, &account_id, &payload_hash)
            .await
            .expect("link attempt should succeed");
        assert!(linked.is_some(), "eligible submitted proposal should link");
    }
}
