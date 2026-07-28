//! Full replay of the bronze-derived balance ledger against real backfilled
//! DAO data. Run manually against a database whose bronze backfill is
//! complete (e.g. treasury_db_charts_backfill):
//!
//!   DATABASE_URL=postgresql://.../treasury_db_charts_backfill \
//!     cargo test --test public_balance_ledger_replay -- --ignored --nocapture
//!
//! Asserts the two invariants verification enforces — running balances never
//! negative, native head balance matching the recorded on-chain expectations
//! from the 2026-07 reconciliation — and doubles as the manual debug tool for
//! per-account ledger investigations.

use std::collections::HashMap;
use std::str::FromStr;

use bigdecimal::BigDecimal;
use sqlx::PgPool;

use nt_be::handlers::public_history::silver::balance_history::BalanceLedgerBuilder;
use nt_be::handlers::public_history::silver::balance_history::repository::min_running_balances;
use nt_be::handlers::public_history::silver::models::BronzePublicHistoryRow;

const NATIVE_EXPECTATION_TOLERANCE: &str = "0.0001";
const RELAYER_ACCOUNT: &str = "sponsor.trezu.near";

/// Native head balances recorded during the live archival-RPC reconciliation
/// (2026-07-24). Bronze-derived ledgers must keep reproducing them.
fn recorded_native_expectations() -> HashMap<&'static str, BigDecimal> {
    HashMap::from([
        (
            "n1-staking.sputnik-dao.near",
            BigDecimal::from_str("621.4206").unwrap(),
        ),
        (
            "auroradao.sputnik-dao.near",
            BigDecimal::from_str("28.7830").unwrap(),
        ),
    ])
}

async fn connect_to_backfilled_database() -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must point at a backfilled DB");
    PgPool::connect(&url).await.expect("connect to database")
}

#[ignore = "needs a database with completed bronze backfill; see module docs"]
#[tokio::test]
async fn ledger_replay_is_nonnegative_and_matches_recorded_chain_balances() {
    let pool = connect_to_backfilled_database().await;
    let accounts: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT account_id
        FROM bronze_public_history_cursors
        WHERE source IN (
            'nearblocks_ft'::public_history_source,
            'nearblocks_mt'::public_history_source,
            'nearblocks_receipt'::public_history_source
        )
        GROUP BY account_id
        HAVING COUNT(*) FILTER (WHERE backfill_done) = 3
        ORDER BY account_id
        "#,
    )
    .fetch_all(&pool)
    .await
    .expect("load fully backfilled accounts");
    assert!(
        !accounts.is_empty(),
        "no fully backfilled accounts in this database"
    );

    let expectations = recorded_native_expectations();
    for account_id in &accounts {
        let rows: Vec<BronzePublicHistoryRow> = sqlx::query_as(
            r#"
            SELECT
                b.id, b.account_id, b.source::text AS source, b.source_event_key,
                b.transaction_hash, b.receipt_id, b.event_index, b.block_height,
                b.block_timestamp, b.block_time, b.affected_account_id,
                b.involved_account_id, b.contract_account_id, b.token_id, b.cause,
                b.action_kind, b.method_name, b.delta_amount_raw, b.decimals,
                b.deposit_raw, b.outcome_status, b.raw_payload,
                NULL::bigint AS proposal_ref, NULL::bigint AS proposal_id
            FROM bronze_public_history_events b
            WHERE b.account_id = $1
            ORDER BY b.block_time ASC, b.block_height ASC, b.id ASC
            "#,
        )
        .bind(account_id)
        .fetch_all(&pool)
        .await
        .expect("load bronze rows");

        let result = BalanceLedgerBuilder::new(account_id, RELAYER_ACCOUNT, Vec::new()).build(&rows);
        assert!(
            result.errors.is_empty(),
            "{account_id}: ledger projection errors: {:?}",
            result
                .errors
                .iter()
                .map(|error| &error.reason)
                .collect::<Vec<_>>()
        );

        let mut head_by_asset: HashMap<String, BigDecimal> = HashMap::new();
        for entry in &result.entries {
            assert!(
                entry.balance_after.sign() != bigdecimal::num_bigint::Sign::Minus,
                "{account_id}: negative running balance for {} at block {}: {}",
                entry.asset.token_id(),
                entry.block_height,
                entry.balance_after
            );
            assert!(
                entry.user_balance_after.sign() != bigdecimal::num_bigint::Sign::Minus,
                "{account_id}: negative user balance for {} at block {}: {}",
                entry.asset.token_id(),
                entry.block_height,
                entry.user_balance_after
            );
            assert!(
                entry.user_balance_after <= entry.balance_after
                    || entry.asset.token_id() != "near",
                "{account_id}: native user balance {} exceeds chain balance {} at block {}",
                entry.user_balance_after,
                entry.balance_after,
                entry.block_height
            );
            head_by_asset.insert(entry.asset.token_id().to_string(), entry.balance_after.clone());
        }
        println!(
            "{account_id}: {} entries, {} assets, native head = {:?}",
            result.entries.len(),
            head_by_asset.len(),
            head_by_asset.get("near")
        );

        if let Some(expected) = expectations.get(account_id.as_str()) {
            let native = head_by_asset
                .get("near")
                .expect("native asset present in ledger");
            let tolerance = BigDecimal::from_str(NATIVE_EXPECTATION_TOLERANCE).unwrap();
            let drift = (native - expected).abs();
            assert!(
                drift <= tolerance,
                "{account_id}: native head {native} deviates from recorded on-chain \
                 expectation {expected} by {drift}"
            );
        }
    }
}

#[ignore = "needs a database with a projected silver_balance_history; see module docs"]
#[tokio::test]
async fn persisted_ledger_running_balances_are_nonnegative() {
    let pool = connect_to_backfilled_database().await;
    let accounts: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT account_id FROM silver_balance_history")
            .fetch_all(&pool)
            .await
            .expect("load ledger accounts");
    for account_id in accounts {
        for (asset, min_balance, min_user_balance) in min_running_balances(&pool, &account_id)
            .await
            .expect("min running balances")
        {
            assert!(
                min_balance.sign() != bigdecimal::num_bigint::Sign::Minus,
                "{account_id}: persisted ledger dips negative for {asset}: {min_balance}"
            );
            assert!(
                min_user_balance.sign() != bigdecimal::num_bigint::Sign::Minus,
                "{account_id}: persisted user balance dips negative for {asset}: {min_user_balance}"
            );
        }
    }
}
