use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{BalanceEntryKind, BalanceLedgerEntry, BalanceLedgerOutcome, BalanceSeedRow};

const LEDGER_WRITE_BATCH: usize = 5_000;

pub async fn seed_balances_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<BalanceSeedRow>, sqlx::Error> {
    sqlx::query_as::<_, BalanceSeedRow>(
        r#"
        SELECT DISTINCT ON (asset) asset, balance_after, user_balance_after
        FROM silver_balance_history
        WHERE account_id = $1
          AND block_time < $2
        ORDER BY asset, block_time DESC, block_height DESC, intra_block_seq DESC
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await
}

/// Replaces the ledger suffix for one account. The table is purely derived
/// from bronze, so delete-then-insert is the correct replacement strategy:
/// every running balance downstream of a change is invalid anyway.
/// Observation entries survive: they derive from bronze_balance_observations
/// (archival RPC readings the builder cannot re-create), live on their own
/// staking assets, and stay valid across movement recomputes.
pub async fn replace_ledger_suffix(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
    entries: &[BalanceLedgerEntry],
) -> Result<BalanceLedgerOutcome, sqlx::Error> {
    let deleted = sqlx::query(
        r#"
        DELETE FROM silver_balance_history
        WHERE account_id = $1
          AND block_time >= $2
          AND entry_kind <> 'observation'
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    let mut written = 0u64;
    for batch in entries.chunks(LEDGER_WRITE_BATCH) {
        written += insert_ledger_entries(tx, batch).await?;
    }

    Ok(BalanceLedgerOutcome {
        entries_written: written,
        entries_deleted: deleted,
    })
}

async fn insert_ledger_entries(
    tx: &mut Transaction<'_, Postgres>,
    entries: &[BalanceLedgerEntry],
) -> Result<u64, sqlx::Error> {
    if entries.is_empty() {
        return Ok(0);
    }

    let account_ids: Vec<&str> = entries.iter().map(|e| e.account_id.as_str()).collect();
    let assets: Vec<&str> = entries.iter().map(|e| e.asset.token_id()).collect();
    let token_standards: Vec<&str> = entries
        .iter()
        .map(|e| e.asset.token_standard().as_str())
        .collect();
    let entry_keys: Vec<&str> = entries.iter().map(|e| e.entry_key.as_str()).collect();
    let sources: Vec<&str> = entries.iter().map(|e| e.source.as_str()).collect();
    let source_event_ids: Vec<i64> = entries.iter().map(|e| e.source_event_id).collect();
    let receipt_ids: Vec<Option<&str>> = entries.iter().map(|e| e.receipt_id.as_deref()).collect();
    let transaction_hashes: Vec<Option<&str>> = entries
        .iter()
        .map(|e| e.transaction_hash.as_deref())
        .collect();
    let counterparties: Vec<Option<&str>> =
        entries.iter().map(|e| e.counterparty.as_deref()).collect();
    let block_heights: Vec<i64> = entries.iter().map(|e| e.block_height).collect();
    let block_times: Vec<DateTime<Utc>> = entries.iter().map(|e| e.block_time).collect();
    let intra_block_seqs: Vec<i32> = entries.iter().map(|e| e.intra_block_seq).collect();
    let delta_raws: Vec<BigDecimal> = entries.iter().map(|e| e.delta_raw.clone()).collect();
    let deltas: Vec<BigDecimal> = entries.iter().map(|e| e.delta.clone()).collect();
    let decimals: Vec<i32> = entries.iter().map(|e| e.decimals).collect();
    let balances_before: Vec<BigDecimal> =
        entries.iter().map(|e| e.balance_before.clone()).collect();
    let balances_after: Vec<BigDecimal> = entries.iter().map(|e| e.balance_after.clone()).collect();
    let affects_user_balances: Vec<bool> =
        entries.iter().map(|e| e.affects_user_balance).collect();
    let user_balances_after: Vec<BigDecimal> = entries
        .iter()
        .map(|e| e.user_balance_after.clone())
        .collect();

    let result = sqlx::query(
        r#"
        INSERT INTO silver_balance_history (
            account_id,
            asset,
            token_standard,
            entry_kind,
            entry_key,
            source,
            source_event_id,
            receipt_id,
            transaction_hash,
            counterparty,
            block_height,
            block_time,
            intra_block_seq,
            delta_raw,
            delta,
            decimals,
            balance_before,
            balance_after,
            affects_user_balance,
            user_balance_after
        )
        SELECT
            account_id,
            asset,
            token_standard::public_token_standard,
            $20::public_balance_entry_kind,
            entry_key,
            source::public_history_source,
            source_event_id,
            receipt_id,
            transaction_hash,
            counterparty,
            block_height,
            block_time,
            intra_block_seq,
            delta_raw,
            delta,
            decimals,
            balance_before,
            balance_after,
            affects_user_balance,
            user_balance_after
        FROM UNNEST(
            $1::text[],
            $2::text[],
            $3::text[],
            $4::text[],
            $5::text[],
            $6::bigint[],
            $7::text[],
            $8::text[],
            $9::text[],
            $10::bigint[],
            $11::timestamptz[],
            $12::integer[],
            $13::numeric[],
            $14::numeric[],
            $15::integer[],
            $16::numeric[],
            $17::numeric[],
            $18::boolean[],
            $19::numeric[]
        ) AS t(
            account_id,
            asset,
            token_standard,
            entry_key,
            source,
            source_event_id,
            receipt_id,
            transaction_hash,
            counterparty,
            block_height,
            block_time,
            intra_block_seq,
            delta_raw,
            delta,
            decimals,
            balance_before,
            balance_after,
            affects_user_balance,
            user_balance_after
        )
        "#,
    )
    .bind(&account_ids)
    .bind(&assets)
    .bind(&token_standards)
    .bind(&entry_keys)
    .bind(&sources)
    .bind(&source_event_ids)
    .bind(&receipt_ids)
    .bind(&transaction_hashes)
    .bind(&counterparties)
    .bind(&block_heights)
    .bind(&block_times)
    .bind(&intra_block_seqs)
    .bind(&delta_raws)
    .bind(&deltas)
    .bind(&decimals)
    .bind(&balances_before)
    .bind(&balances_after)
    .bind(&affects_user_balances)
    .bind(&user_balances_after)
    .bind(BalanceEntryKind::Movement.as_str())
    .execute(&mut **tx)
    .await?;

    Ok(result.rows_affected())
}

/// Per-asset minimum running balances (chain and user-owned) across the full
/// ledger — the non-negativity invariants checked by verification.
pub async fn min_running_balances(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<(String, BigDecimal, BigDecimal)>, sqlx::Error> {
    sqlx::query_as::<_, (String, BigDecimal, BigDecimal)>(
        r#"
        SELECT asset, MIN(balance_after), MIN(user_balance_after)
        FROM silver_balance_history
        WHERE account_id = $1
        GROUP BY asset
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}
