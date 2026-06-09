/// End-to-end integration tests for balance change indexing.
///
/// Tests both Goldsky enrichment and maintenance (gap-filling) paths for
/// webassemblymusic-treasury.sputnik-dao.near, verified against production
/// (api.trezu.app).
///
/// Uses `experimental_tx_status` to resolve receipt blocks and real archival RPC
/// for balance queries.
///
/// ```bash
/// cargo test --test goldsky_e2e_test -- --nocapture
/// ```
mod common;

use axum::body::Body;
use axum::http::Request;
use base64::Engine;
use nt_be::handlers::balance_changes::transfer_hints::neardata::NeardataClient;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Instant;
use tower::ServiceExt;

/// Balance change record — fields we inspect in the API response.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceChangeRecord {
    block_height: i64,
    token_id: String,
    amount: String,
    balance_before: String,
    balance_after: String,
    counterparty: Option<String>,
    signer_id: Option<String>,
    receiver_id: Option<String>,
    action_kind: Option<String>,
    method_name: Option<String>,
    actions: Option<serde_json::Value>,
    transaction_hashes: Vec<String>,
}

/// Reference record from production (api.trezu.app) for hard assertions.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceRecord {
    block_height: i64,
    token_id: String,
    amount: String,
    counterparty: String,
    action_kind: Option<String>,
}

/// Recent activity response from /api/recent-activity
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentActivityResponse {
    data: Vec<RecentActivityItem>,
    total: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentActivityItem {
    id: i64,
    token_id: String,
    amount: String,
    swap: Option<SwapInfo>,
    action_kind: Option<String>,
    method_name: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapInfo {
    sent_token_id: Option<String>,
    sent_amount: Option<String>,
    received_token_id: String,
    received_amount: String,
    solver_transaction_hash: String,
    swap_role: String,
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

/// Query the API-filtered count (records that pass all WHERE clauses).
async fn api_filtered_count(pool: &PgPool, account_id: &str) -> i64 {
    let result: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM balance_changes WHERE account_id = $1 \
         AND counterparty != 'SNAPSHOT' \
         AND counterparty != 'STAKING_SNAPSHOT' \
         AND counterparty != 'NOT_REGISTERED' \
         AND (amount != 0 OR balance_before != balance_after) \
         AND (action_kind IS NULL OR action_kind != 'CreateAccount') \
         AND counterparty != 'sponsor.trezu.near'",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .unwrap();
    result.0
}

/// Tests enrichment for webassemblymusic-treasury.sputnik-dao.near.
///
/// Uses 46 Neon outcomes from blocks 188101232–188492987 and verifies that the
/// pipeline produces correct balance change records.
///
/// Covers: direct transfers, sponsor relay (Delegate meta-tx), act_proposal
/// execution, USDC ft_transfer, intents swap (mt_burn/mt_transfer), wrap.near
/// deposit, a failed wrap.near execution, and intents mt_mint (NEAR deposit).
#[sqlx::test]
async fn test_goldsky_webassemblymusic(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let network = common::create_archival_network();

    let total_start = Instant::now();

    // -----------------------------------------------------------------------
    // 1. Load fixture data + register account
    // -----------------------------------------------------------------------
    load_fixtures(
        &pool,
        include_str!("test_data/goldsky_webassemblymusic_fixtures.sql"),
    )
    .await;

    let fixture_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM indexed_dao_outcomes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fixture_count.0, 46, "Expected 46 fixture rows loaded");
    println!(
        "Loaded {} fixture rows into indexed_dao_outcomes",
        fixture_count.0
    );

    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, enabled, dirty_at, plan_type)
         VALUES ($1, true, NOW(), 'enterprise')",
    )
    .bind(account_id)
    .execute(&pool)
    .await
    .unwrap();

    // Pre-seed cursor at block 0 so enrichment processes all fixtures
    // (without this, get_cursor would seed from the latest fixture block)
    sqlx::query(
        "INSERT INTO goldsky_cursors (consumer_name, last_processed_id, last_processed_block, updated_at)
         VALUES ('balance_enrichment', '', 0, NOW())",
    )
    .execute(&pool)
    .await
    .unwrap();

    // -----------------------------------------------------------------------
    // 2. Run enrichment cycles until all outcomes are processed
    // -----------------------------------------------------------------------
    let env_vars = nt_be::utils::env::EnvVars::default();
    let intents_api_key = env_vars.intents_explorer_api_key.as_deref();
    let intents_api_url = &env_vars.intents_explorer_api_url;

    let enrichment_start = Instant::now();
    let mut total_processed = 0usize;
    loop {
        let processed = nt_be::handlers::balance_changes::goldsky_enrichment::run_enrichment_cycle(
            &pool,
            &pool,
            &network,
            intents_api_key,
            intents_api_url,
            None,
        )
        .await
        .unwrap();
        total_processed += processed;
        if processed < 100 {
            break;
        }
    }
    let enrichment_elapsed = enrichment_start.elapsed();
    println!(
        "Enrichment: processed {} outcomes in {:.2}s",
        total_processed,
        enrichment_elapsed.as_secs_f64()
    );

    let after_enrichment = api_filtered_count(&pool, account_id).await;
    println!("After enrichment: {} API-visible records", after_enrichment);

    // -----------------------------------------------------------------------
    // 3. Query the HTTP API (enrichment-only, no maintenance)
    // -----------------------------------------------------------------------
    let state = Arc::new(common::build_test_state(pool.clone()));
    let app = nt_be::routes::create_routes(state);

    let request = Request::builder()
        .uri(format!(
            "/api/balance-changes?accountId={account_id}&limit=100"
        ))
        .body(Body::empty())
        .unwrap();

    let response = ServiceExt::<Request<Body>>::oneshot(app, request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let records: Vec<BalanceChangeRecord> =
        serde_json::from_slice(&body).expect("Failed to parse API response JSON");

    let total_elapsed = total_start.elapsed();

    // -----------------------------------------------------------------------
    // 4. Print summary
    // -----------------------------------------------------------------------
    println!("\n========== RESULTS ==========");
    println!("Fixtures:        {} outcomes", fixture_count.0);
    println!(
        "Enrichment:      {} processed in {:.2}s",
        total_processed,
        enrichment_elapsed.as_secs_f64()
    );
    println!("API records:     {}", records.len());
    println!("Total time:      {:.2}s", total_elapsed.as_secs_f64());
    println!("=============================\n");

    println!("API-visible balance changes ({} records):", records.len());
    for r in &records {
        let token_short = if r.token_id.len() > 30 {
            &r.token_id[..30]
        } else {
            &r.token_id
        };
        println!(
            "  block={} token={:<30} amount={:<25} counterparty={:<30} action={:?} tx={:?}",
            r.block_height,
            token_short,
            r.amount,
            r.counterparty.as_deref().unwrap_or("-"),
            r.action_kind,
            r.transaction_hashes,
        );
    }

    // -----------------------------------------------------------------------
    // 5. Hard expectations — must match production (api.trezu.app)
    //
    // Enrichment alone should find records 1-4 via experimental_tx_status
    // receipt block resolution + Path A/B/C event parsing.
    // -----------------------------------------------------------------------
    let find = |block: i64, token: &str| -> Option<&BalanceChangeRecord> {
        records
            .iter()
            .find(|r| r.block_height == block && r.token_id == token)
    };

    // Also dump all DB records (including non-API-visible) for debugging
    let all_db: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT block_height, token_id, amount::TEXT, counterparty \
         FROM balance_changes WHERE account_id = $1 \
         ORDER BY block_height ASC",
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    println!("\nAll DB records ({}):", all_db.len());
    for (block, token, amount, cp) in &all_db {
        let token_short = if token.len() > 40 {
            &token[..40]
        } else {
            token.as_str()
        };
        println!(
            "  block={} token={:<40} amount={:<25} cp={}",
            block, token_short, amount, cp
        );
    }

    // --- Record 1: block 188101233, NEAR +0.432 (Transfer from petersalomonsen.near) ---
    // Path B: receiver_id = DAO, signer = petersalomonsen.near, trigger block 188101232
    // tx_status resolves receipt block to 188101233 (cross-shard +1 block).
    let r1 = find(188_101_233, "near")
        .expect("Missing: block 188101233 NEAR (petersalomonsen.near Transfer deposit)");
    assert_eq!(r1.counterparty.as_deref(), Some("petersalomonsen.near"));
    assert!(
        r1.amount.starts_with("0.432"),
        "Expected amount ~0.432, got {}",
        r1.amount
    );
    println!("\nRecord 1 OK: block=188101233 NEAR +{}", r1.amount);

    // --- Record 2: block 188102293, NEAR +0.0969 (FunctionCall, Path C) ---
    // Path C: executor_id = DAO, receiver_id = petersalomonsen.near, trigger block 188102291
    // tx_status resolves receipt block to 188102293.
    let r2 = find(188_102_293, "near")
        .expect("Missing: block 188102293 NEAR (act_proposal Path C cross-contract)");
    assert_eq!(r2.counterparty.as_deref(), Some("petersalomonsen.near"));
    assert!(
        r2.amount.starts_with("0.09"),
        "Expected amount ~0.0969, got {}",
        r2.amount
    );
    println!("Record 2 OK: block=188102293 NEAR +{}", r2.amount);

    // --- Record 3: block 188102397, NEAR -0.000735 (intents swap gas) ---
    // Path C: executor_id = DAO, receiver_id = petersalomonsen.near, trigger block 188102395
    // tx_status resolves receipt block to 188102397.
    let r3 =
        find(188_102_397, "near").expect("Missing: block 188102397 NEAR (intents swap gas cost)");
    assert!(
        r3.amount.starts_with("-0.000"),
        "Expected small negative amount, got {}",
        r3.amount
    );
    println!("Record 3 OK: block=188102397 NEAR {}", r3.amount);

    // --- Record 4: block 188102398, intents USDC -10 ---
    // Path A: mt_burn log event from intents.near mentioning DAO as owner_id
    // tx_status resolves receipt block to 188102398.
    let intents_usdc =
        "intents.near:nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let r4 = find(188_102_398, intents_usdc)
        .expect("Missing: block 188102398 intents USDC (intents swap)");
    assert_eq!(r4.amount, "-10", "Expected -10 USDC, got {}", r4.amount);
    println!("Record 4 OK: block=188102398 intents USDC {}", r4.amount);

    // --- Record 5: block 188102401, NEAR -0.0999 (on_proposal_callback → Transfer to petersalomonsen) ---
    // The DAO's balance drops at 188102401 when on_proposal_callback commits the
    // outgoing 0.1 NEAR transfer. petersalomonsen.near receives it one block later
    // (188102402). Path C sets counterparty from the Goldsky receiver_id which is
    // petersalomonsen.near — verified correct via RPC balance queries.
    let r5 = find(188_102_401, "near")
        .expect("Missing: block 188102401 NEAR (on_proposal_callback Transfer to petersalomonsen)");
    assert!(
        r5.amount.starts_with("-0.09"),
        "Expected amount ~-0.0999, got {}",
        r5.amount
    );
    assert_eq!(r5.counterparty.as_deref(), Some("petersalomonsen.near"));
    println!("Record 5 OK: block=188102401 NEAR {}", r5.amount);

    // --- Record 6: block ~188492987, intents.near:nep141:wrap.near +1 NEAR (mt_mint deposit) ---
    // Path A: mt_mint log event from intents.near with owner_id = DAO
    // The DAO receives 1 NEAR (1000000000000000000000000 yoctoNEAR) as intents wrap.near token.
    let intents_wrap_near = "intents.near:nep141:wrap.near";
    let r6 = records
        .iter()
        .find(|r| r.token_id == intents_wrap_near)
        .expect("Missing: intents.near:nep141:wrap.near (mt_mint NEAR deposit)");
    assert_eq!(r6.counterparty.as_deref(), Some("intents.near"));
    assert!(
        r6.amount.starts_with("1"),
        "Expected ~1 NEAR (intents wrap.near), got {}",
        r6.amount
    );
    println!(
        "Record 6 OK: block={} intents wrap.near {} (mt_mint)",
        r6.block_height, r6.amount
    );

    // -----------------------------------------------------------------------
    // 6. Verify action_kind, method_name, and proposal id from tx_status actions
    //
    // The act_proposal records (blocks 188102397-188102401, tx 9noKHxN...) should
    // have action_kind=FUNCTION_CALL, method_name=act_proposal, and the actions
    // array should contain the FunctionCall with decodable args including the
    // proposal id. The add_proposal record (block 188102293) should likewise have
    // action_kind=FUNCTION_CALL and method_name=add_proposal.
    // -----------------------------------------------------------------------

    // Record at block 188102401: act_proposal via sponsor Delegate meta-transaction
    let r5 =
        find(188_102_401, "near").expect("Missing record at block 188102401 for action assertions");
    assert_eq!(r5.action_kind.as_deref(), Some("FUNCTION_CALL"));
    assert_eq!(r5.method_name.as_deref(), Some("act_proposal"));

    // Extract proposal id from the FunctionCall args in the actions array.
    // For meta-transactions, the FunctionCall is inside the Delegate.
    let actions = r5.actions.as_ref().expect("actions should be present");
    let actions_arr = actions.as_array().expect("actions should be an array");

    let func_call = actions_arr
        .iter()
        .find_map(|a| a.get("FunctionCall"))
        .or_else(|| {
            actions_arr.iter().find_map(|a| {
                a.get("Delegate")?
                    .get("delegate_action")?
                    .get("actions")?
                    .as_array()?
                    .iter()
                    .find_map(|inner| inner.get("FunctionCall"))
            })
        })
        .expect("actions should contain a FunctionCall");

    assert_eq!(
        func_call.get("method_name").and_then(|v| v.as_str()),
        Some("act_proposal"),
    );

    let args_b64 = func_call
        .get("args")
        .and_then(|v| v.as_str())
        .expect("FunctionCall should have args");
    let args_bytes = base64::engine::general_purpose::STANDARD
        .decode(args_b64)
        .expect("args should be valid base64");
    let args: serde_json::Value =
        serde_json::from_slice(&args_bytes).expect("args should be valid JSON");
    let proposal_id = args
        .get("id")
        .and_then(|v| v.as_u64())
        .expect("act_proposal args should contain proposal 'id'");
    assert_eq!(proposal_id, 56, "Expected proposal id 56");
    println!(
        "\nProposal id extracted from act_proposal actions: {}",
        proposal_id
    );

    // Record at block 188102293: add_proposal via sponsor Delegate
    let r2 =
        find(188_102_293, "near").expect("Missing record at block 188102293 for action assertions");
    assert_eq!(r2.action_kind.as_deref(), Some("FUNCTION_CALL"));
    assert_eq!(r2.method_name.as_deref(), Some("add_proposal"));

    // Record at block 188101233: direct Transfer (not Delegate)
    let r1 =
        find(188_101_233, "near").expect("Missing record at block 188101233 for action assertions");
    assert_eq!(r1.action_kind.as_deref(), Some("TRANSFER"));
    assert!(
        r1.method_name.is_none(),
        "Transfer should not have method_name"
    );

    println!("\nExpected production records verified (enrichment-only).");

    // -----------------------------------------------------------------------
    // 7. Verify swap detection via /api/recent-activity
    //
    // The enrichment cycle should have detected the intents swap at blocks
    // 188487531-188487545 (USDC → USDC exchange). The recent-activity API
    // enriches balance changes with swap info from the detected_swaps table.
    // -----------------------------------------------------------------------
    let state2 = Arc::new(common::build_test_state(pool.clone()));
    let app2 = nt_be::routes::create_routes(state2);

    let request = Request::builder()
        .uri(format!(
            "/api/recent-activity?accountId={account_id}&limit=100"
        ))
        .body(Body::empty())
        .unwrap();

    let response = ServiceExt::<Request<Body>>::oneshot(app2, request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let activity: RecentActivityResponse =
        serde_json::from_slice(&body).expect("Failed to parse recent-activity response");

    println!(
        "\nRecent activity: {} items (total={})",
        activity.data.len(),
        activity.total
    );

    // Find swap items (items that have swap info)
    let swap_items: Vec<_> = activity.data.iter().filter(|a| a.swap.is_some()).collect();
    println!("Swap items found: {}", swap_items.len());
    for item in &swap_items {
        let swap = item.swap.as_ref().unwrap();
        println!(
            "  token={} amount={} role={} sent={:?}/{:?} recv={}/{}",
            item.token_id,
            item.amount,
            swap.swap_role,
            swap.sent_token_id,
            swap.sent_amount,
            swap.received_token_id,
            swap.received_amount,
        );
    }

    // There should be at least 1 swap detected (the intents USDC exchange)
    assert!(
        !swap_items.is_empty(),
        "Expected at least one swap in recent-activity, but found none"
    );

    // Find the fulfillment leg of the swap (positive intents token transfer)
    let fulfillment = swap_items
        .iter()
        .find(|a| {
            a.swap
                .as_ref()
                .is_some_and(|s| s.swap_role == "fulfillment")
        })
        .expect("Expected a swap fulfillment item in recent-activity");
    let fulfillment_swap = fulfillment.swap.as_ref().unwrap();

    // Verify swap amounts match production: sent ~20 USDC, received ~19.86 USDC
    assert_eq!(fulfillment_swap.swap_role, "fulfillment");
    assert!(
        fulfillment_swap
            .sent_amount
            .as_ref()
            .is_some_and(|a| a.starts_with("20")),
        "Expected sent_amount ~20, got {:?}",
        fulfillment_swap.sent_amount
    );
    assert!(
        fulfillment_swap.received_amount.starts_with("19.85"),
        "Expected received_amount ~19.85, got {}",
        fulfillment_swap.received_amount
    );

    // Find the deposit leg
    let deposit = swap_items
        .iter()
        .find(|a| a.swap.as_ref().is_some_and(|s| s.swap_role == "deposit"));
    if let Some(deposit_item) = deposit {
        let deposit_swap = deposit_item.swap.as_ref().unwrap();
        assert_eq!(deposit_swap.swap_role, "deposit");
        println!(
            "\nSwap deposit leg verified: sent={:?} recv={}",
            deposit_swap.sent_amount, deposit_swap.received_amount
        );
    }

    println!("\nSwap detection verified via recent-activity API.");
}

/// Tests maintenance (gap-filling) for webassemblymusic-treasury.sputnik-dao.near.
///
/// Unlike the enrichment test, this uses NO Goldsky fixture data. Instead, it
/// registers the account with `maintenance_block_floor` set to constrain the
/// scan range, marks it dirty, and runs `run_maintenance_cycle` which discovers
/// balance changes through the transfer-hints gap-filling pipeline.
///
/// Hard-asserts all 5 production records match the reference dataset from
/// api.trezu.app.
///
/// The `maintenance_block_floor` field prevents the default 600k-block lookback,
/// constraining the scan to ~1200 blocks covering blocks 188101230–188102410.
#[sqlx::test]
async fn test_goldsky_maintenance_webassemblymusic(pool: PgPool) {
    common::load_test_env();
    let _ = env_logger::try_init();

    let account_id = "webassemblymusic-treasury.sputnik-dao.near";
    let network = common::create_archival_network();

    let total_start = Instant::now();

    // -----------------------------------------------------------------------
    // 1. Register account with maintenance_block_floor (no Goldsky fixtures)
    // -----------------------------------------------------------------------
    let maintenance_floor: i64 = 188_101_230; // Just before first expected record
    let up_to_block: i64 = 188_102_410; // Just after last expected record

    sqlx::query(
        "INSERT INTO monitored_accounts (account_id, enabled, dirty_at, maintenance_block_floor, plan_type)
         VALUES ($1, true, NOW(), $2, 'enterprise')",
    )
    .bind(account_id)
    .bind(maintenance_floor)
    .execute(&pool)
    .await
    .unwrap();

    println!(
        "Registered {} with maintenance_block_floor={}, up_to_block={}",
        account_id, maintenance_floor, up_to_block
    );

    // -----------------------------------------------------------------------
    // 2. Run maintenance cycles until convergence (gap-filling only)
    //
    // The binary search gap filler finds one split point per gap per cycle,
    // so multiple cycles are needed to discover all balance changes.
    // -----------------------------------------------------------------------
    let maintenance_start = Instant::now();
    let mut cycle_count = 0;
    loop {
        cycle_count += 1;

        // Use total DB record count (not API-filtered) for convergence,
        // because non-visible records (e.g., sponsor.trezu.near) still
        // create sub-gaps that subsequent cycles need to fill.
        let before: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        // Re-mark account as dirty for each cycle
        sqlx::query("UPDATE monitored_accounts SET dirty_at = NOW() WHERE account_id = $1")
            .bind(account_id)
            .execute(&pool)
            .await
            .unwrap();

        let neardata = NeardataClient::from_env();
        let mut state = common::build_test_state_archival(pool.clone());
        state.neardata_client = Some(neardata);
        nt_be::handlers::balance_changes::account_monitor::run_maintenance_cycle(
            &state,
            up_to_block,
        )
        .await
        .unwrap();

        let after: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM balance_changes WHERE account_id = $1")
                .bind(account_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        println!(
            "Maintenance cycle {}: {} -> {} total DB records",
            cycle_count, before.0, after.0
        );

        // Stop when no new records found, or after safety limit
        if after.0 == before.0 || cycle_count >= 10 {
            break;
        }
    }
    let maintenance_elapsed = maintenance_start.elapsed();
    println!(
        "Maintenance: {} cycles in {:.2}s",
        cycle_count,
        maintenance_elapsed.as_secs_f64()
    );

    let after_maintenance = api_filtered_count(&pool, account_id).await;
    println!(
        "After maintenance: {} API-visible records",
        after_maintenance
    );

    // -----------------------------------------------------------------------
    // 3. Query the HTTP API
    // -----------------------------------------------------------------------
    let state = Arc::new(common::build_test_state(pool.clone()));
    let app = nt_be::routes::create_routes(state);

    let request = Request::builder()
        .uri(format!(
            "/api/balance-changes?accountId={account_id}&limit=100"
        ))
        .body(Body::empty())
        .unwrap();

    let response = ServiceExt::<Request<Body>>::oneshot(app, request)
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let records: Vec<BalanceChangeRecord> =
        serde_json::from_slice(&body).expect("Failed to parse API response JSON");

    let total_elapsed = total_start.elapsed();

    // -----------------------------------------------------------------------
    // 4. Print summary
    // -----------------------------------------------------------------------
    println!("\n========== MAINTENANCE RESULTS ==========");
    println!("Maintenance:     {:.2}s", maintenance_elapsed.as_secs_f64());
    println!("API records:     {}", records.len());
    println!("Total time:      {:.2}s", total_elapsed.as_secs_f64());
    println!("=========================================\n");

    println!("API-visible balance changes ({} records):", records.len());
    for r in &records {
        let token_short = if r.token_id.len() > 30 {
            &r.token_id[..30]
        } else {
            &r.token_id
        };
        println!(
            "  block={} token={:<30} amount={:<25} counterparty={:<30} action={:?}",
            r.block_height,
            token_short,
            r.amount,
            r.counterparty.as_deref().unwrap_or("-"),
            r.action_kind,
        );
    }

    // -----------------------------------------------------------------------
    // 5. Hard expectations — must match production (api.trezu.app)
    //
    // Load reference data and assert all 5 records are found with correct
    // block_height, token_id, amount, and counterparty.
    // -----------------------------------------------------------------------
    let reference: Vec<ReferenceRecord> = serde_json::from_str(include_str!(
        "test_data/goldsky_webassemblymusic_reference.json"
    ))
    .expect("Failed to parse reference JSON");

    let find = |block: i64, token: &str| -> Option<&BalanceChangeRecord> {
        records
            .iter()
            .find(|r| r.block_height == block && r.token_id == token)
    };

    // Dump all DB records for debugging
    let all_db: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT block_height, token_id, amount::TEXT, counterparty \
         FROM balance_changes WHERE account_id = $1 \
         ORDER BY block_height ASC",
    )
    .bind(account_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    println!("\nAll DB records ({}):", all_db.len());
    for (block, token, amount, cp) in &all_db {
        let token_short = if token.len() > 40 {
            &token[..40]
        } else {
            token.as_str()
        };
        println!(
            "  block={} token={:<40} amount={:<25} cp={}",
            block, token_short, amount, cp
        );
    }

    println!("\nVerifying {} reference records:", reference.len());
    for (i, ref_rec) in reference.iter().enumerate() {
        let actual = find(ref_rec.block_height, &ref_rec.token_id).unwrap_or_else(|| {
            panic!(
                "Missing reference record {}: block={} token={}",
                i + 1,
                ref_rec.block_height,
                ref_rec.token_id
            )
        });

        // Amount: use starts_with for NEAR (RPC precision may vary), exact for FT
        if ref_rec.token_id == "near" {
            // Match first significant digits (at least 3 chars for sign + digits)
            let ref_prefix = if ref_rec.amount.starts_with('-') {
                &ref_rec.amount[..6.min(ref_rec.amount.len())]
            } else {
                &ref_rec.amount[..5.min(ref_rec.amount.len())]
            };
            assert!(
                actual.amount.starts_with(ref_prefix),
                "Record {} (block {}): expected amount starting with '{}', got '{}'",
                i + 1,
                ref_rec.block_height,
                ref_prefix,
                actual.amount
            );
        } else {
            assert_eq!(
                actual.amount,
                ref_rec.amount,
                "Record {} (block {}): expected amount '{}', got '{}'",
                i + 1,
                ref_rec.block_height,
                ref_rec.amount,
                actual.amount
            );
        }

        // Counterparty
        assert_eq!(
            actual.counterparty.as_deref(),
            Some(ref_rec.counterparty.as_str()),
            "Record {} (block {}): expected counterparty '{}', got {:?}",
            i + 1,
            ref_rec.block_height,
            ref_rec.counterparty,
            actual.counterparty
        );

        println!(
            "  Record {} OK: block={} token={} amount={} cp={}",
            i + 1,
            ref_rec.block_height,
            if ref_rec.token_id.len() > 20 {
                &ref_rec.token_id[..20]
            } else {
                &ref_rec.token_id
            },
            actual.amount,
            ref_rec.counterparty
        );
    }

    println!(
        "\nAll {} production reference records verified (maintenance-only).",
        reference.len()
    );
}
