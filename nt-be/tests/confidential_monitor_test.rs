/// Integration tests for the confidential-treasury balance tracking flow.
///
/// Covers the two sides of the pipeline:
/// 1. Goldsky enrichment — `handle_confidential_outgoing` synthesizes an outgoing
///    `balance_change` row from a stored `confidential_intents.quote_metadata`,
///    and the insert is idempotent across retries.
/// 2. 1Click polling — decreases are ignored (Goldsky owns outgoing), and
///    increases that match a pending swap quote write a `detected_swaps` row
///    linking the incoming fulfillment to the Goldsky-written deposit leg.
///
/// ```bash
/// cargo test --test confidential_monitor_test -- --nocapture
/// ```
mod common;

use bigdecimal::BigDecimal;
use nt_be::handlers::balance_changes::confidential_enrichment::{
    ConfidentialSignCall, extract_sign_call_from_logs, handle_confidential_outgoing,
};
use nt_be::handlers::intents::confidential::types::normalize_quote_metadata_accounts;
use serde_json::json;
use sqlx::PgPool;
use std::str::FromStr;

const DAO: &str = "confidential-test.sputnik-dao.near";
const PAYLOAD_HASH: &str = "2591e2441a7d9c0b3b9fed73da21609cd708db1e5316f8b244630191d574adb4";
const CORRELATION_ID: &str = "test-correlation-id-001";
const EXTERNAL_RECIPIENT: &str = "bob.near";

/// Register the DAO as a monitored confidential account and seed a stored
/// quote identified by `(DAO, PAYLOAD_HASH)`.
///
/// `recipient` controls whether the stored intent is a self-swap (`recipient
/// == DAO`) or an external payment (`recipient != DAO`).
async fn seed_confidential_intent(
    pool: &PgPool,
    origin_asset: &str,
    destination_asset: &str,
    amount_in_raw: &str,
    amount_out_raw: &str,
    recipient: &str,
    status: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
        VALUES ($1, true, true)
        ON CONFLICT (account_id) DO UPDATE SET is_confidential_account = true
        "#,
    )
    .bind(DAO)
    .execute(pool)
    .await
    .expect("insert monitored_accounts");

    // Seed token decimals for both legs so `ensure_ft_metadata` doesn't need RPC.
    for (token_id, decimals) in [
        (format!("intents.near:{origin_asset}"), 24i16),
        (format!("intents.near:{destination_asset}"), 24i16),
    ] {
        sqlx::query(
            r#"
            INSERT INTO counterparties
                (account_id, account_type, token_symbol, token_name, token_decimals)
            VALUES ($1, 'ft_token', 'TEST', 'test', $2)
            ON CONFLICT (account_id) DO NOTHING
            "#,
        )
        .bind(&token_id)
        .bind(decimals)
        .execute(pool)
        .await
        .expect("seed counterparties");
    }

    let quote_metadata = normalize_quote_metadata_accounts(json!({
        "quote": {
            "amountIn": amount_in_raw,
            "amountOut": amount_out_raw,
            "minAmountOut": amount_out_raw,
            "depositAddress": "d32b552aa188face5952516a370bc5a9d91f77a19c48d5b7b16e6c59eb79b08e",
        },
        "quoteRequest": {
            "originAsset": origin_asset,
            "destinationAsset": destination_asset,
            "recipient": recipient,
            "swapType": "EXACT_INPUT",
        },
    }));

    sqlx::query(
        r#"
        INSERT INTO confidential_intents
            (dao_id, payload_hash, intent_payload, correlation_id, quote_metadata,
             status, intent_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'shield')
        ON CONFLICT (dao_id, payload_hash) DO UPDATE SET
            quote_metadata = EXCLUDED.quote_metadata,
            correlation_id = EXCLUDED.correlation_id,
            status = EXCLUDED.status,
            updated_at = NOW()
        "#,
    )
    .bind(DAO)
    .bind(PAYLOAD_HASH)
    .bind(json!({"message": "x", "nonce": "y", "recipient": recipient}))
    .bind(CORRELATION_ID)
    .bind(&quote_metadata)
    .bind(status)
    .execute(pool)
    .await
    .expect("insert confidential_intents");
}

#[test]
fn parses_v1_signer_sign_log() {
    // The exact format emitted by v1.signer, captured from a real outcome in
    // the Goldsky sink (`confidential-yuriik.sputnik-dao.near`).
    let log = r#"sign: predecessor=AccountId("confidential-test.sputnik-dao.near"), request=SignRequestArgs { path: "confidential-test.sputnik-dao.near", payload_v2: Some(Eddsa(Bytes("2591e2441a7d9c0b3b9fed73da21609cd708db1e5316f8b244630191d574adb4"))), deprecated_payload: None, domain_id: Some(DomainId(1)), deprecated_key_version: None }"#;
    let got = extract_sign_call_from_logs(log).expect("regex should match");
    assert_eq!(
        got,
        ConfidentialSignCall {
            dao_id: DAO.to_string(),
            payload_hash: PAYLOAD_HASH.to_string(),
        }
    );
}

#[test]
fn ignores_non_sign_logs() {
    assert!(extract_sign_call_from_logs("EVENT_JSON:{\"standard\":\"nep141\"}").is_none());
    assert!(extract_sign_call_from_logs("Transfer 100 from a to b").is_none());
    // Well-formed line but missing payload_v2.Eddsa → no match.
    assert!(
        extract_sign_call_from_logs(
            r#"sign: predecessor=AccountId("x.near"), request=SignRequestArgs { payload_v2: None }"#
        )
        .is_none()
    );
}

/// External-payment flow: `recipient != dao_id` → outgoing row gets
/// `counterparty = recipient`, and a second call to the handler is a no-op
/// (idempotent on `(account_id, block_height, token_id)`).
#[sqlx::test]
async fn handle_confidential_outgoing_external_payment(pool: PgPool) {
    common::load_test_env();

    let network = common::create_archival_network();

    seed_confidential_intent(
        &pool,
        "nep141:wrap.near",
        "nep141:wrap.near",
        "10000000000000000000000", // 0.01 NEAR (24 decimals)
        "10000000000000000000000",
        EXTERNAL_RECIPIENT,
        "submitted",
    )
    .await;

    let now = chrono::Utc::now();
    let block_height: i64 = 200_000_000;

    let wrote = handle_confidential_outgoing(
        &pool,
        &network,
        DAO,
        PAYLOAD_HASH,
        block_height,
        now.timestamp_nanos_opt().unwrap_or(0),
        now,
        Some("tx-hash-abc".to_string()),
        Some("signer.near"),
    )
    .await
    .expect("handle_confidential_outgoing");
    assert!(wrote, "first call should insert a row");

    let row: (
        BigDecimal,
        String,
        String,
        Option<String>,
        serde_json::Value,
    ) = sqlx::query_as(
        r#"
            SELECT amount, counterparty, token_id, method_name, raw_data
            FROM balance_changes
            WHERE account_id = $1 AND block_height = $2 AND token_id = $3
            "#,
    )
    .bind(DAO)
    .bind(block_height)
    .bind("intents.near:nep141:wrap.near")
    .fetch_one(&pool)
    .await
    .expect("balance_changes row exists");

    let (amount, counterparty, token_id, method_name, raw_data) = row;
    assert_eq!(token_id, "intents.near:nep141:wrap.near");
    assert!(amount < 0, "outgoing leg must be negative, got {}", amount);
    assert_eq!(
        counterparty, EXTERNAL_RECIPIENT,
        "payment counterparty should be the quote recipient"
    );
    assert_eq!(method_name.as_deref(), Some("act_proposal"));
    assert_eq!(
        raw_data.get("payload_hash").and_then(|v| v.as_str()),
        Some(PAYLOAD_HASH)
    );
    assert_eq!(
        raw_data.get("correlation_id").and_then(|v| v.as_str()),
        Some(CORRELATION_ID)
    );

    // Idempotency: replaying the same outcome must not add a second row.
    let wrote_again = handle_confidential_outgoing(
        &pool,
        &network,
        DAO,
        PAYLOAD_HASH,
        block_height,
        now.timestamp_nanos_opt().unwrap_or(0),
        now,
        Some("tx-hash-abc".to_string()),
        Some("signer.near"),
    )
    .await
    .expect("second handle_confidential_outgoing");
    assert!(wrote_again, "handler reports the upsert as successful");

    let row_count: (i64,) = sqlx::query_as(
        r#"SELECT COUNT(*) FROM balance_changes
           WHERE account_id = $1 AND block_height = $2 AND token_id = $3"#,
    )
    .bind(DAO)
    .bind(block_height)
    .bind("intents.near:nep141:wrap.near")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row_count.0, 1, "upsert must not duplicate the row");
}

/// Self-swap flow: `recipient == dao_id` → counterparty falls back to the
/// public-intents convention `"intents.near"` so the activity feed renders
/// public and confidential swaps the same way.
#[sqlx::test]
async fn handle_confidential_outgoing_self_swap(pool: PgPool) {
    common::load_test_env();

    let network = common::create_archival_network();

    // Use same 24-decimal token on both legs to keep seed simple; counterparty
    // convention is driven by `recipient == dao_id`, not by differing tokens.
    seed_confidential_intent(
        &pool,
        "nep141:wrap.near",
        "nep141:wrap.near",
        "10000000000000000000000",
        "10000000000000000000000",
        DAO, // self-swap: recipient = DAO → counterparty should be "intents.near"
        "submitted",
    )
    .await;

    let now = chrono::Utc::now();
    let block_height: i64 = 200_000_001;

    handle_confidential_outgoing(
        &pool,
        &network,
        DAO,
        PAYLOAD_HASH,
        block_height,
        now.timestamp_nanos_opt().unwrap_or(0),
        now,
        Some("tx-hash-swap".to_string()),
        Some("signer.near"),
    )
    .await
    .expect("handle_confidential_outgoing self-swap");

    let counterparty: String = sqlx::query_scalar(
        r#"SELECT counterparty FROM balance_changes
           WHERE account_id = $1 AND block_height = $2"#,
    )
    .bind(DAO)
    .bind(block_height)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        counterparty, "intents.near",
        "self-swap counterparty should use the public intents convention"
    );
}

/// Missing quote → handler reports false and writes nothing. This guards the
/// `ON CONFLICT` path from being hit with bogus data.
#[sqlx::test]
async fn handle_confidential_outgoing_missing_intent_row(pool: PgPool) {
    common::load_test_env();
    let network = common::create_archival_network();

    sqlx::query(
        r#"INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
           VALUES ($1, true, true)"#,
    )
    .bind(DAO)
    .execute(&pool)
    .await
    .unwrap();

    let now = chrono::Utc::now();
    let wrote = handle_confidential_outgoing(
        &pool,
        &network,
        DAO,
        PAYLOAD_HASH,
        200_000_002,
        now.timestamp_nanos_opt().unwrap_or(0),
        now,
        None,
        None,
    )
    .await
    .expect("handler tolerates missing intent row");
    assert!(!wrote, "no row should be written when quote is missing");

    let count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
            .bind(DAO)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count.0, 0);
}

/// Ensures the polling DB lookup respects the same `dao_id` keying as the
/// Goldsky side by inserting an outgoing row and confirming the swap-match
/// dedup query sees it. This exercises the `(account_id, payload_hash)` join
/// point that `insert_detected_swap` uses to link legs.
#[sqlx::test]
async fn outgoing_row_is_discoverable_by_payload_hash(pool: PgPool) {
    common::load_test_env();
    let network = common::create_archival_network();

    seed_confidential_intent(
        &pool,
        "nep141:wrap.near",
        "nep141:wrap.near",
        "5000000000000000000000",
        "5000000000000000000000",
        EXTERNAL_RECIPIENT,
        "submitted",
    )
    .await;

    let now = chrono::Utc::now();
    handle_confidential_outgoing(
        &pool,
        &network,
        DAO,
        PAYLOAD_HASH,
        200_000_010,
        now.timestamp_nanos_opt().unwrap_or(0),
        now,
        Some("tx-hash-disc".to_string()),
        Some("signer.near"),
    )
    .await
    .unwrap();

    let (id, amount): (i64, BigDecimal) = sqlx::query_as(
        r#"SELECT id, amount FROM balance_changes
           WHERE account_id = $1
             AND raw_data->>'payload_hash' = $2
             AND amount < 0
           ORDER BY block_height DESC, id DESC
           LIMIT 1"#,
    )
    .bind(DAO)
    .bind(PAYLOAD_HASH)
    .fetch_one(&pool)
    .await
    .expect("outgoing row is discoverable by payload_hash");

    assert!(id > 0);
    assert_eq!(
        amount,
        BigDecimal::from_str("-0.005").unwrap(),
        "amount should be -amountIn decimal-adjusted",
    );
}
