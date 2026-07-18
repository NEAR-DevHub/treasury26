/// Integration test for wNEAR swap deposit detection via NEAR Transfer proposals.
///
/// Reproduces the issue where lesik_o.sputnik-dao.near swaps 0.1 NEAR → 0.133142 USDC
/// via a Transfer proposal. The fulfillment (USDC credit) is detected but the deposit
/// (NEAR send) was not linked because:
///   1. The deposit tx hash is in originChainTxHashes, not nearTxHashes
///   2. The balance change has token_id="near", not "wrap.near"
///   3. The method_name is "act_proposal", not "on_proposal_callback"
///
/// Uses Goldsky fixtures + mock intents API. The public recent-activity API now
/// reads public gold rows, so this legacy Goldsky test asserts the
/// `detected_swaps` linkage directly.
///
/// ```bash
/// cargo test --test wnear_swap_deposit_test -- --nocapture
/// ```
mod common;

use sqlx::PgPool;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

const ACCOUNT_ID: &str = "lesik_o.sputnik-dao.near";
const FULFILLMENT_TX: &str = "FDLLrpWgAGMF6S2tMozrKTUy2nhdBfSAEeUvrpvcwdK3";
const DEPOSIT_TX: &str = "9CLCjpPN2tY6UE7HNd5e5eABLedzVrvXTvLUGJDwXgEq";
const INTENTS_USDC_TOKEN: &str =
    "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

#[derive(Debug, sqlx::FromRow)]
struct SwapLegRow {
    role: String,
    token_id: String,
    amount: String,
    transaction_hashes: Vec<String>,
    sent_token_id: Option<String>,
    received_token_id: String,
    solver_transaction_hash: String,
}

/// Load fixture SQL into indexed_dao_outcomes.
async fn load_fixtures(pool: &PgPool, fixture_sql: &str) {
    for stmt in fixture_sql.split(';').filter(|s| !s.trim().is_empty()) {
        let trimmed = stmt.trim();
        if trimmed.starts_with("--") && !trimmed.contains("INSERT") {
            continue;
        }
        sqlx::query(trimmed)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("Failed to execute fixture SQL: {e}\nStatement: {trimmed}"));
    }
}

/// Build mock Intents Explorer API response for the wNEAR → USDC swap.
fn intents_api_response() -> serde_json::Value {
    serde_json::json!([{
        "originAsset": "nep141:wrap.near",
        "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "recipient": ACCOUNT_ID,
        "status": "SUCCESS",
        "amountInFormatted": "0.1",
        "amountOutFormatted": "0.133142",
        "nearTxHashes": [
            "5EVPr3vkAoLMcAiuSq3qLWWZsRjPeXpaugnqerLBh52y",
            FULFILLMENT_TX
        ],
        "originChainTxHashes": [DEPOSIT_TX]
    }])
}

/// Start a wiremock server that returns the intents API response.
async fn start_mock_intents_server() -> MockServer {
    let mock_server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/transactions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(intents_api_response()))
        .mount(&mock_server)
        .await;
    mock_server
}

/// Helper to query legacy exchange legs through detected_swaps.
async fn query_legacy_exchange_legs(pool: &PgPool) -> Vec<SwapLegRow> {
    sqlx::query_as::<_, SwapLegRow>(
        "SELECT
            'fulfillment' AS role,
            bc.token_id,
            bc.amount::TEXT AS amount,
            bc.transaction_hashes,
            ds.sent_token_id,
            ds.received_token_id,
            ds.solver_transaction_hash
         FROM detected_swaps ds
         JOIN balance_changes bc ON bc.id = ds.fulfillment_balance_change_id
         WHERE ds.account_id = $1
           AND ds.solver_transaction_hash = $2

         UNION ALL

         SELECT
            'deposit' AS role,
            bc.token_id,
            bc.amount::TEXT AS amount,
            bc.transaction_hashes,
            ds.sent_token_id,
            ds.received_token_id,
            ds.solver_transaction_hash
         FROM detected_swaps ds
         JOIN balance_changes bc ON bc.id = ds.deposit_balance_change_id
         WHERE ds.account_id = $1
           AND ds.solver_transaction_hash = $2

         ORDER BY role",
    )
    .bind(ACCOUNT_ID)
    .bind(FULFILLMENT_TX)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// End-to-end test: load Goldsky fixtures, run enrichment with mock intents API,
/// then verify both swap legs are linked in detected_swaps.
#[sqlx::test]
async fn test_wnear_swap_deposit_detected_via_enrichment(pool: PgPool) {
    common::load_test_env();
    nt_be::observability::init_tracing();

    let network = common::create_archival_network();

    // -----------------------------------------------------------------------
    // 1. Load Goldsky fixtures + register monitored account + seed cursor
    // -----------------------------------------------------------------------
    load_fixtures(
        &pool,
        include_str!("test_data/goldsky_lesik_wnear_swap_fixtures.sql"),
    )
    .await;

    let fixture_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM indexed_dao_outcomes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fixture_count.0, 9, "Expected 9 fixture rows loaded");

    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, enabled, dirty_at, plan_type)
         VALUES ($1, true, NOW(), 'enterprise')",
    )
    .bind(ACCOUNT_ID)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ('balance_enrichment', '', 0, NOW())",
    )
    .execute(&pool)
    .await
    .unwrap();

    // -----------------------------------------------------------------------
    // 2. Start mock intents API + run enrichment
    // -----------------------------------------------------------------------
    let mock_intents = start_mock_intents_server().await;
    let intents_api_url = mock_intents.uri();

    let mut total_processed = 0usize;
    loop {
        let processed = nt_be::handlers::balance_changes::goldsky_enrichment::run_enrichment_cycle(
            &pool,
            &pool,
            &network,
            Some("test_key"),
            &intents_api_url,
            None,
        )
        .await
        .unwrap();
        total_processed += processed;
        if processed < 100 {
            break;
        }
    }
    println!("Enrichment: processed {} outcomes", total_processed);
    assert!(
        total_processed >= 9,
        "Should process all 9 fixture outcomes"
    );

    // -----------------------------------------------------------------------
    // 3. Query the linked exchange legs and verify both sides
    // -----------------------------------------------------------------------
    let exchange = query_legacy_exchange_legs(&pool).await;

    println!("\nLegacy exchange legs: {} entries", exchange.len());
    for item in &exchange {
        println!(
            "  token={} amount={} tx={:?} role={}",
            item.token_id, item.amount, item.transaction_hashes, item.role,
        );
    }

    // There should be at least the fulfillment entry
    let fulfillment = exchange
        .iter()
        .find(|item| item.role == "fulfillment")
        .expect("Should have a fulfillment entry in detected_swaps");

    assert_eq!(fulfillment.token_id, INTENTS_USDC_TOKEN);
    assert_eq!(fulfillment.solver_transaction_hash, FULFILLMENT_TX);
    assert_eq!(
        fulfillment.sent_token_id.as_deref(),
        Some("intents.near:nep141:wrap.near"),
        "Sent token should be intents-prefixed wrap.near"
    );
    assert_eq!(fulfillment.received_token_id, INTENTS_USDC_TOKEN);

    // The deposit leg should also be linked.
    let deposits: Vec<_> = exchange
        .iter()
        .filter(|item| item.role == "deposit")
        .collect();

    assert_eq!(
        deposits.len(),
        1,
        "Should have exactly 1 deposit entry (not duplicates from sibling balance changes)"
    );

    let deposit = deposits[0];
    assert!(
        deposit.amount.starts_with('-'),
        "Deposit amount should be negative (outgoing): {}",
        deposit.amount
    );
    assert_eq!(
        deposit.token_id, "near",
        "Deposit token should be 'near' (raw NEAR Transfer)"
    );

    // Total linked exchange legs: 1 fulfillment + 1 deposit
    assert_eq!(
        exchange.len(),
        2,
        "Detected swap should have exactly 2 linked legs"
    );

    println!("\nAll assertions passed!");
}
