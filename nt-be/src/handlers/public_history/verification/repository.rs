use bigdecimal::BigDecimal;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{
    AssetCheckOutcome, AssetLedgerHead, VerificationCheckKind, VerificationStatus,
    VerificationWatermark,
};

/// Rebase entries sort after any real movement in the same block, so a later
/// bronze ingest landing at the watermark block can never collide with the
/// (account, asset, block_height, intra_block_seq) uniqueness.
const REBASE_INTRA_BLOCK_SEQ: i32 = 1_000_000;

/// Accounts whose gold projection is ready but whose ledger has not passed
/// on-chain verification. Failed accounts retry after the cool-off so a
/// broken account cannot monopolize RPC.
pub async fn load_gate_candidates(
    pool: &PgPool,
    failed_retry_after_hours: i64,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT gold_cursor.account_id
        FROM gold_public_history_cursors gold_cursor
        JOIN monitored_accounts monitored
          ON monitored.account_id = gold_cursor.account_id
         AND monitored.enabled = true
         AND COALESCE(monitored.is_confidential_account, false) = false
        LEFT JOIN public_balance_verification_cursors verification
          ON verification.account_id = gold_cursor.account_id
        WHERE gold_cursor.projection_ready_at IS NOT NULL
          AND (
              verification.account_id IS NULL
              OR verification.status = 'unverified'
              OR (
                  verification.status = 'failed'
                  AND verification.updated_at
                        < NOW() - make_interval(hours => $1::integer)
              )
          )
        ORDER BY gold_cursor.account_id
        "#,
    )
    .bind(failed_retry_after_hours as i32)
    .fetch_all(pool)
    .await
}

/// Passed accounts whose ledger advanced past the last head check, throttled
/// to once per hour per account.
pub async fn load_head_check_candidates(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT verification.account_id
        FROM public_balance_verification_cursors verification
        JOIN monitored_accounts monitored
          ON monitored.account_id = verification.account_id
         AND monitored.enabled = true
         AND COALESCE(monitored.is_confidential_account, false) = false
        WHERE verification.status = 'passed'
          AND (
              verification.last_head_check_at IS NULL
              OR verification.last_head_check_at < NOW() - INTERVAL '1 hour'
          )
          AND COALESCE(verification.last_head_check_block_height, 0) < (
              SELECT COALESCE(MAX(block_height), 0)
              FROM silver_balance_history ledger
              WHERE ledger.account_id = verification.account_id
          )
        ORDER BY verification.account_id
        "#,
    )
    .fetch_all(pool)
    .await
}

/// The common coverage watermark: the lowest verified provider cutoff across
/// the three sources, with the oldest of their drain times. NULL cutoffs mean
/// coverage is unproven, so the account has no watermark yet.
pub async fn load_watermark(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<VerificationWatermark>, sqlx::Error> {
    sqlx::query_as::<_, VerificationWatermark>(
        r#"
        SELECT
            MIN(latest_refresh_cutoff_block_height) AS cutoff_block_height,
            MIN(latest_refresh_at) AS refreshed_at
        FROM bronze_public_history_cursors
        WHERE account_id = $1
          AND source IN (
              'nearblocks_ft'::public_history_source,
              'nearblocks_mt'::public_history_source,
              'nearblocks_receipt'::public_history_source
          )
        HAVING COUNT(*) = 3
           AND COUNT(latest_refresh_cutoff_block_height) = 3
           AND COUNT(latest_refresh_at) = 3
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// One row per asset: the ledger head balance plus the running-minimum
/// invariant, in a single scan.
pub async fn load_asset_ledger_heads(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<AssetLedgerHead>, sqlx::Error> {
    sqlx::query_as::<_, AssetLedgerHead>(
        r#"
        SELECT DISTINCT ON (asset)
            asset,
            token_standard::text AS token_standard,
            balance_after,
            MIN(balance_after) OVER (PARTITION BY asset) AS min_balance_after,
            user_balance_after,
            MIN(user_balance_after) OVER (PARTITION BY asset) AS min_user_balance_after,
            block_height AS head_block_height,
            decimals
        FROM silver_balance_history
        WHERE account_id = $1
          -- Verification is native-NEAR only. Staking series ARE
          -- authoritative RPC readings (observations), and FT/MT balances
          -- can accrue without transfer events (venear.dao vote-escrow), so
          -- an exact-drift chain check would fail ledgers that are correct.
          AND token_standard = 'native'::public_token_standard
          AND asset NOT LIKE 'staking:%'
        ORDER BY asset, block_time DESC, block_height DESC, intra_block_seq DESC
        "#,
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
}

pub async fn record_check_results(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    check_kind: VerificationCheckKind,
    block_height: i64,
    outcomes: &[AssetCheckOutcome],
) -> Result<(), sqlx::Error> {
    for outcome in outcomes {
        sqlx::query(
            r#"
            INSERT INTO public_balance_verification_results (
                account_id, asset, check_kind, block_height,
                ledger_balance, chain_balance, drift, min_running_balance, passed
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(account_id)
        .bind(&outcome.asset)
        .bind(check_kind.as_str())
        .bind(block_height)
        .bind(&outcome.ledger_balance)
        .bind(&outcome.chain_balance)
        .bind(&outcome.drift)
        .bind(&outcome.min_running_balance)
        .bind(outcome.passed)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn set_gate_status(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    status: VerificationStatus,
    block_height: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO public_balance_verification_cursors (
            account_id, status, verified_at, verified_block_height, updated_at
        )
        VALUES (
            $1, $2::public_balance_verification_status,
            CASE WHEN $2 = 'passed' THEN NOW() END, $3, NOW()
        )
        ON CONFLICT (account_id) DO UPDATE SET
            status = EXCLUDED.status,
            verified_at = CASE
                WHEN EXCLUDED.status = 'passed' THEN NOW()
                ELSE public_balance_verification_cursors.verified_at
            END,
            verified_block_height = EXCLUDED.verified_block_height,
            updated_at = NOW()
        "#,
    )
    .bind(account_id)
    .bind(status.as_str())
    .bind(block_height)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn set_head_check_result(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    block_height: i64,
    passed: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE public_balance_verification_cursors
        SET last_head_check_at = NOW(),
            last_head_check_block_height = $2,
            last_head_check_passed = $3,
            updated_at = NOW()
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .bind(block_height)
    .bind(passed)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Append a hidden reconciliation entry re-anchoring one asset's ledger to
/// the observed on-chain balance at the watermark block. The next silver
/// recompute seeds from it; a full recompute drops it and the verifier simply
/// re-derives the (bounded) drift.
#[allow(clippy::too_many_arguments)]
pub async fn insert_rebase_entry(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    asset: &str,
    token_standard: &str,
    block_height: i64,
    decimals: i32,
    ledger_balance: &BigDecimal,
    observed_balance: &BigDecimal,
    user_balance: &BigDecimal,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        INSERT INTO silver_balance_history (
            account_id, asset, token_standard, entry_kind, entry_key,
            source, source_event_id, receipt_id, transaction_hash, counterparty,
            block_height, block_time, intra_block_seq,
            delta_raw, delta, decimals, balance_before, balance_after,
            affects_user_balance, user_balance_after
        )
        VALUES (
            $1, $2, $3::public_token_standard, 'reconciliation',
            'rebase:' || $1 || ':' || $2 || ':' || $4::text,
            NULL, NULL, NULL, NULL, 'on-chain-verification',
            $4, NOW(), $5,
            ($7 - $6) * POWER(10::numeric, $8), $7 - $6, $8, $6, $7,
            FALSE, $9
        )
        ON CONFLICT (entry_key) DO NOTHING
        "#,
    )
    .bind(account_id)
    .bind(asset)
    .bind(token_standard)
    .bind(block_height)
    .bind(REBASE_INTRA_BLOCK_SEQ)
    .bind(ledger_balance)
    .bind(observed_balance)
    .bind(decimals)
    .bind(user_balance)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

const NATIVE_LEDGER_HEAD_SQL: &str = r#"
    SELECT balance_after, user_balance_after, block_height
    FROM silver_balance_history
    WHERE account_id = $1 AND asset = 'near'
    ORDER BY block_time DESC, block_height DESC, intra_block_seq DESC
    LIMIT 1
"#;

/// The native ledger head: (chain-side balance, user-owned balance, block).
pub async fn load_native_ledger_head(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<(BigDecimal, BigDecimal, i64)>, sqlx::Error> {
    sqlx::query_as(NATIVE_LEDGER_HEAD_SQL)
        .bind(account_id)
        .fetch_optional(pool)
        .await
}

pub async fn load_native_ledger_head_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Option<(BigDecimal, BigDecimal, i64)>, sqlx::Error> {
    sqlx::query_as(NATIVE_LEDGER_HEAD_SQL)
        .bind(account_id)
        .fetch_optional(&mut **tx)
        .await
}
