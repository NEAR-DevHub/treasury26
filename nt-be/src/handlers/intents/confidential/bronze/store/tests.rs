use super::*;
use crate::handlers::intents::confidential::bronze::api::{HistoryEvent, HistoryItem};
use crate::utils::env::EnvVars;
use chrono::{Duration, Utc};

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

async fn test_pool() -> sqlx::PgPool {
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

    let first_result = upsert_history_events(&pool, &account_id, std::slice::from_ref(&event))
        .await
        .expect("first upsert should succeed");
    let second_result = upsert_history_events(&pool, &account_id, std::slice::from_ref(&event))
        .await
        .expect("second upsert should succeed");

    let row_count: i64 = sqlx::query_scalar(
        r#"
            SELECT COUNT(*)
            FROM bronze_confidential_history_events
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

    assert_eq!(first_result.rows_touched, 1);
    assert_eq!(first_result.rows_inserted, 1);
    assert_eq!(first_result.rows_changed, 0);
    assert_eq!(
        first_result.events[0].state,
        HistoryEventUpsertState::Inserted
    );
    assert_eq!(second_result.rows_touched, 1);
    assert_eq!(second_result.rows_inserted, 0);
    assert_eq!(second_result.rows_changed, 0);
    assert_eq!(second_result.rows_unchanged, 1);
    assert_eq!(
        second_result.events[0].state,
        HistoryEventUpsertState::Unchanged
    );
    assert_eq!(row_count, 1);
}

#[tokio::test]
#[ignore]
async fn test_save_cursors_split_preserves_independent_columns() {
    let pool = test_pool().await;
    let account_id = format!("test-confidential-cursor-{}-dao.near", uuid::Uuid::new_v4());

    save_backfill_progress(&pool, &account_id, Some("backward-1"), Some("forward-1"))
        .await
        .expect("initial backfill progress save should succeed");
    save_latest_page_cursor(&pool, &account_id, Some("forward-2"))
        .await
        .expect("latest-page cursor save must not touch backward_cursor");
    save_backfill_progress(&pool, &account_id, Some("backward-2"), None)
        .await
        .expect("backfill advance must not touch forward_cursor");

    let cursor = load_history_cursor(&pool, &account_id)
        .await
        .expect("cursor load should succeed")
        .expect("cursor row should exist");

    assert_eq!(cursor.forward_cursor.as_deref(), Some("forward-2"));
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

    save_backfill_progress(&pool, &account_id, Some("backward-1"), Some("forward-1"))
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
async fn test_record_confidential_history_poll_result_schedules_from_activity() {
    let pool = test_pool().await;
    let account_id = format!(
        "test-confidential-schedule-{}-dao.near",
        uuid::Uuid::new_v4()
    );

    record_confidential_history_poll_result(&pool, &account_id, true)
        .await
        .expect("changed latest page should schedule");

    let changed_cursor = load_history_cursor(&pool, &account_id)
        .await
        .expect("cursor load should succeed")
        .expect("cursor row should exist");

    assert!(changed_cursor.last_confidential_activity_at.is_some());
    assert!(changed_cursor.next_poll_at <= Utc::now() + Duration::seconds(35));

    sqlx::query(
        r#"
        UPDATE bronze_confidential_history_cursors
        SET last_confidential_activity_at = NOW() - INTERVAL '3 hours'
        WHERE account_id = $1
        "#,
    )
    .bind(&account_id)
    .execute(&pool)
    .await
    .expect("activity timestamp update should succeed");

    record_confidential_history_poll_result(&pool, &account_id, false)
        .await
        .expect("unchanged latest page should schedule");

    let unchanged_cursor = load_history_cursor(&pool, &account_id)
        .await
        .expect("cursor load should succeed")
        .expect("cursor row should exist");
    assert!(unchanged_cursor.next_poll_at <= Utc::now() + Duration::seconds(605));
    assert!(unchanged_cursor.next_poll_at > Utc::now() + Duration::seconds(500));
}

#[tokio::test]
#[ignore]
async fn test_load_due_confidential_history_accounts_filters_by_next_poll_at() {
    let pool = test_pool().await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let missing_cursor = format!("test-{}-missing.near", &suffix[..8]);
    let due_cursor = format!("test-{}-due.near", &suffix[..8]);
    let future_cursor = format!("test-{}-future.near", &suffix[..8]);
    let disabled = format!("test-{}-disabled.near", &suffix[..8]);
    let public = format!("test-{}-public.near", &suffix[..8]);

    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
        VALUES
            ($1, true, true),
            ($2, true, true),
            ($3, true, true),
            ($4, false, true),
            ($5, true, false)
        ON CONFLICT (account_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            is_confidential_account = EXCLUDED.is_confidential_account
        "#,
    )
    .bind(&missing_cursor)
    .bind(&due_cursor)
    .bind(&future_cursor)
    .bind(&disabled)
    .bind(&public)
    .execute(&pool)
    .await
    .expect("test monitored accounts should insert");

    sqlx::query(
        r#"
        INSERT INTO bronze_confidential_history_cursors (account_id, next_poll_at)
        VALUES
            ($1, NOW() - INTERVAL '1 second'),
            ($2, NOW() + INTERVAL '1 hour')
        ON CONFLICT (account_id) DO UPDATE SET
            next_poll_at = EXCLUDED.next_poll_at
        "#,
    )
    .bind(&due_cursor)
    .bind(&future_cursor)
    .execute(&pool)
    .await
    .expect("test cursor rows should insert");

    let accounts = load_due_confidential_history_accounts(&pool, 50)
        .await
        .expect("due account load should succeed");

    assert!(accounts.contains(&missing_cursor));
    assert!(accounts.contains(&due_cursor));
    assert!(!accounts.contains(&future_cursor));
    assert!(!accounts.contains(&disabled));
    assert!(!accounts.contains(&public));
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

#[tokio::test]
async fn link_intent_matches_after_quote_metadata_canonicalized() {
    let pool = test_pool().await;
    let account_id = format!("test-bare-recipient-{}.near", uuid::Uuid::new_v4());
    let payload_hash = uuid::Uuid::new_v4().simple().to_string();
    let mut event = sample_history_event();
    event.item.deposit_address = format!("deposit-{}", uuid::Uuid::new_v4());
    event.item.recipient = Some(account_id.clone());
    if let serde_json::Value::Object(ref mut raw) = event.raw_payload {
        raw.insert(
            "recipient".to_string(),
            serde_json::Value::String(account_id.clone()),
        );
    }

    upsert_history_events(&pool, &account_id, &[event.clone()])
        .await
        .expect("bronze upsert should succeed");

    let quote_metadata =
        crate::handlers::intents::confidential::types::normalize_quote_metadata_accounts(
            serde_json::json!({
                "quote": { "depositAddress": event.item.deposit_address },
                "quoteRequest": {
                    "recipient": account_id,
                    "recipientType": "CONFIDENTIAL_INTENTS",
                    "destinationAsset": event.item.destination_asset
                }
            }),
        );

    sqlx::query(
        r#"
        INSERT INTO confidential_intents (
            dao_id, payload_hash, intent_payload, quote_metadata,
            deposit_address, status, proposal_id
        )
        VALUES ($1, $2, $3, $4, $5, 'submitted', 1)
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

    let linked = link_intent_to_history_event(&pool, &account_id, &payload_hash)
        .await
        .expect("link should not error");
    assert!(
        linked.is_some(),
        "bare quote recipient should match bronze recipient exactly"
    );
}

#[tokio::test]
async fn link_intent_matches_cross_chain_destination_recipient() {
    let pool = test_pool().await;
    let account_id = format!("test-cross-chain-{}.near", uuid::Uuid::new_v4());
    let payload_hash = uuid::Uuid::new_v4().simple().to_string();
    let evm_recipient = "0xabc1234567890abcdef";
    let destination_asset = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";

    let mut event = sample_history_event();
    event.item.deposit_address = format!("deposit-{}", uuid::Uuid::new_v4());
    event.item.recipient = Some(evm_recipient.to_string());
    event.item.recipient_type = Some("DESTINATION_CHAIN".to_string());
    event.item.destination_asset = destination_asset.to_string();
    if let serde_json::Value::Object(ref mut raw) = event.raw_payload {
        raw.insert(
            "recipient".to_string(),
            serde_json::Value::String(evm_recipient.to_string()),
        );
        raw.insert(
            "recipientType".to_string(),
            serde_json::Value::String("DESTINATION_CHAIN".to_string()),
        );
        raw.insert(
            "destinationAsset".to_string(),
            serde_json::Value::String(destination_asset.to_string()),
        );
    }

    upsert_history_events(&pool, &account_id, &[event.clone()])
        .await
        .expect("bronze upsert should succeed");

    let quote_metadata =
        crate::handlers::intents::confidential::types::normalize_quote_metadata_accounts(
            serde_json::json!({
                "quote": { "depositAddress": event.item.deposit_address },
                "quoteRequest": {
                    "recipient": evm_recipient,
                    "recipientType": "DESTINATION_CHAIN",
                    "originAsset": "nep141:wrap.near",
                    "destinationAsset": destination_asset
                }
            }),
        );

    sqlx::query(
        r#"
        INSERT INTO confidential_intents (
            dao_id, payload_hash, intent_payload, quote_metadata,
            deposit_address, status, proposal_id
        )
        VALUES ($1, $2, $3, $4, $5, 'submitted', 1)
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

    let linked = link_intent_to_history_event(&pool, &account_id, &payload_hash)
        .await
        .expect("link should not error");
    assert!(
        linked.is_some(),
        "bare evm quote recipient should match bronze recipient exactly"
    );

    let bronze_recipient: Option<String> = sqlx::query_scalar(
        r#"
        SELECT recipient
        FROM bronze_confidential_history_events
        WHERE account_id = $1 AND deposit_address = $2
        "#,
    )
    .bind(&account_id)
    .bind(&event.item.deposit_address)
    .fetch_one(&pool)
    .await
    .expect("bronze row should exist");
    assert_eq!(bronze_recipient.as_deref(), Some(evm_recipient));
}
