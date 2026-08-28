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
/// on-chain verification. Failed accounts retry after the cool-off — or as
/// soon as their silver ledger was rebuilt after the failed check (new
/// evidence), floored at a minimum interval so a busy account cannot burn
/// RPC on every ledger write.
pub async fn load_gate_candidates(
    pool: &PgPool,
    failed_retry_after_hours: i64,
    failed_retry_min_minutes: i64,
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
        LEFT JOIN silver_public_history_cursors silver
          ON silver.account_id = gold_cursor.account_id
        WHERE gold_cursor.projection_ready_at IS NOT NULL
          AND (
              verification.account_id IS NULL
              OR verification.status = 'unverified'
              OR (
                  verification.status = 'failed'
                  AND verification.updated_at
                        < NOW() - make_interval(mins => $2::integer)
                  AND (
                      verification.updated_at
                            < NOW() - make_interval(hours => $1::integer)
                      OR silver.updated_at > verification.updated_at
                  )
              )
          )
        ORDER BY gold_cursor.account_id
        "#,
    )
    .bind(failed_retry_after_hours as i32)
    .bind(failed_retry_min_minutes as i32)
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
const LOAD_ASSET_LEDGER_HEADS_SQL: &str = r#"
        WITH cap AS (
            -- MAX, not MIN: clamp_account_to_head writes all 3 source
            -- cursors atomically with the identical value, but nothing in
            -- the schema enforces that. This asset is native, sourced
            -- exclusively from nearblocks_receipt — MAX(all 3 sources'
            -- caps) is guaranteed >= the receipt source's own cap, so it
            -- can never admit receipt data that's still pre-cap. MIN would
            -- do exactly that whenever receipt isn't the lowest of the
            -- three — the unsafe direction, not the safe one.
            SELECT MAX(capped_at_block_height) AS capped_at_block_height
            FROM bronze_public_history_cursors
            WHERE account_id = $1 AND backfill_capped = true
        ),
        ledger AS (
            SELECT silver_balance_history.*
            FROM silver_balance_history, cap
            WHERE account_id = $1
              -- Verification is native-NEAR only. Staking series ARE
              -- authoritative RPC readings (observations), and FT/MT balances
              -- can accrue without transfer events (venear.dao vote-escrow), so
              -- an exact-drift chain check would fail ledgers that are correct.
              AND token_standard = 'native'::public_token_standard
              AND asset NOT LIKE 'staking:%'
              -- A capped account's pre-clamp rows are unreconciled history
              -- kept for display only; an old negative dip from before the
              -- clamp must never sink the running-minimum invariant below.
              AND block_height >= COALESCE(cap.capped_at_block_height, block_height)
        ),
        anchors AS (
            SELECT asset, MAX(block_height) AS anchor_block
            FROM ledger
            WHERE entry_kind = 'reconciliation'
            GROUP BY asset
        ),
        -- Single scalar derived from `anchors` (already computed) instead of
        -- each of the two CTEs below re-deriving the same
        -- MAX(block_height WHERE entry_kind = 'reconciliation') via its own
        -- correlated subquery over `ledger` — same value, one scan instead
        -- of three. Native-only verification means at most one asset here,
        -- so collapsing per-asset anchors to a single scalar loses nothing.
        recon_anchor AS (
            SELECT COALESCE(MAX(anchor_block), -1) AS anchor_block
            FROM anchors
        ),
        -- Gas rebates accrue per successful inbound receipt regardless of
        -- whether it moves value — most don't, so counting ledger entries
        -- (movements only) systematically under-budgets busy accounts. The
        -- receipt itself, not its projection into the ledger, is the true
        -- unit of gas-dust cost; ledger is already native-only and filtered
        -- to this account, so the anchor window comes from it directly.
        receipt_counts AS (
            SELECT COUNT(DISTINCT bronze.receipt_id) AS inbound_receipt_count
            FROM bronze_public_history_events bronze, cap, recon_anchor
            WHERE bronze.account_id = $1
              AND bronze.source = 'nearblocks_receipt'::public_history_source
              AND bronze.affected_account_id = $1
              AND bronze.outcome_status = true
              -- Unlike ledger, this reads bronze directly, so a capped
              -- account's pre-cap receipts need their own floor here — an
              -- unbounded pre-cap history would otherwise inflate the count
              -- into a gas-dust budget large enough to hide real post-cap
              -- drift.
              AND bronze.block_height >= COALESCE(cap.capped_at_block_height, bronze.block_height)
              AND bronze.block_height > recon_anchor.anchor_block
        ),
        -- How much user-tagged spend the builder's clamp (assign_running_
        -- balances) has redirected to sponsor-funded since the anchor —
        -- the observable trace of a would-be negative user balance, not a
        -- failure signal in itself. `is_sponsor_clamp` is the persisted
        -- flag the builder stamps on that exact piece — not a pattern match
        -- against entry_key, whose ':sponsor-clamp' suffix exists only to
        -- keep it unique against its sibling piece.
        sponsor_absorbed AS (
            SELECT COALESCE(-SUM(delta), 0) AS sponsor_absorbed
            FROM ledger, recon_anchor
            WHERE ledger.is_sponsor_clamp
              AND ledger.block_height > recon_anchor.anchor_block
        )
        SELECT DISTINCT ON (ledger.asset)
            ledger.asset,
            token_standard::text AS token_standard,
            balance_after,
            -- Scoped to after the reconciliation anchor, same as event_count
            -- and sponsor_absorbed below: an old negative dip a rebase has
            -- already accounted for must not keep failing the account
            -- forever. Unanchored accounts fall back to the full history
            -- (COALESCE(anchors.anchor_block, -1) — no real block height is
            -- <= -1), matching pre-anchor behavior exactly. The outer
            -- COALESCE covers the anchor-is-the-latest-row case, where the
            -- FILTER matches nothing and the window MIN is NULL — the row's
            -- own balance_after (the only/latest point, at or before the
            -- anchor) is the correct minimum in that case.
            COALESCE(
                MIN(balance_after) FILTER (
                    WHERE ledger.block_height > COALESCE(anchors.anchor_block, -1)
                ) OVER (PARTITION BY ledger.asset),
                balance_after
            ) AS min_balance_after,
            user_balance_after,
            COALESCE(
                MIN(user_balance_after) FILTER (
                    WHERE ledger.block_height > COALESCE(anchors.anchor_block, -1)
                ) OVER (PARTITION BY ledger.asset),
                user_balance_after
            ) AS min_user_balance_after,
            block_height AS head_block_height,
            decimals,
            receipt_counts.inbound_receipt_count AS event_count,
            anchors.anchor_block IS NOT NULL AS has_anchor,
            sponsor_absorbed.sponsor_absorbed
        FROM ledger
        LEFT JOIN anchors ON anchors.asset = ledger.asset
        CROSS JOIN receipt_counts
        CROSS JOIN sponsor_absorbed
        ORDER BY ledger.asset, block_time DESC, block_height DESC, intra_block_seq DESC
"#;

pub async fn load_asset_ledger_heads(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<AssetLedgerHead>, sqlx::Error> {
    sqlx::query_as::<_, AssetLedgerHead>(LOAD_ASSET_LEDGER_HEADS_SQL)
        .bind(account_id)
        .fetch_all(pool)
        .await
}

/// Same query, inside an open transaction — for re-reading ledger heads
/// after a write earlier in the same transaction (e.g. a just-inserted
/// reconciliation anchor) that a separate pool connection wouldn't see yet.
pub async fn load_asset_ledger_heads_tx(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Vec<AssetLedgerHead>, sqlx::Error> {
    sqlx::query_as::<_, AssetLedgerHead>(LOAD_ASSET_LEDGER_HEADS_SQL)
        .bind(account_id)
        .fetch_all(&mut **tx)
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
                ledger_balance, chain_balance, drift, min_running_balance,
                min_user_running_balance, sponsor_absorbed, passed
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
        .bind(&outcome.min_user_running_balance)
        .bind(&outcome.sponsor_absorbed)
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
///
/// `block_time` is stamped `NOW()`, not the watermark block's own on-chain
/// timestamp — pre-existing on this function, shared by both callers
/// (`rebase_within_tolerance`'s regular drift-absorption pass and
/// `verify_account_gate`'s history-only bootstrap). `load_asset_ledger_heads`
/// orders `DISTINCT ON` by `block_time DESC` first, so this is only safe
/// because `NOW()` is called after live RPC confirms `block_height` is the
/// account's current head — nothing at a higher block_height can exist yet
/// to be mis-ordered against. A future caller that reconciles at a block
/// height that ISN'T the confirmed current head would not have that
/// guarantee and should not reuse this function as-is.
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
