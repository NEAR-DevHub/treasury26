use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::models::{
    BalanceStampRow, BalanceStamps, DirtyPublicGoldAccount, GoldPublicHistoryEvent,
};
use crate::handlers::public_history::quotes::QUOTE_LEG_MATCH_SQL;
use crate::handlers::public_history::silver::models::SilverTransferLegRow;

pub async fn load_dirty_accounts(
    pool: &PgPool,
) -> Result<Vec<DirtyPublicGoldAccount>, sqlx::Error> {
    sqlx::query_as::<_, DirtyPublicGoldAccount>(
        r#"
        SELECT
            account_id,
            COALESCE(gold_dirty_since, updated_at) AS dirty_since,
            gold_recompute_from AS recompute_from
        FROM gold_public_history_cursors
        WHERE (
              gold_dirty_since IS NOT NULL
              OR (
                  projection_validation_pending = true
                  AND NOT EXISTS (
                      SELECT 1
                      FROM silver_public_history_projection_errors silver_error
                      WHERE silver_error.account_id = gold_public_history_cursors.account_id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM gold_public_history_projection_errors gold_error
                      WHERE gold_error.dao_id = gold_public_history_cursors.account_id
                  )
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM silver_public_history_cursors silver_cursor
              WHERE silver_cursor.account_id = gold_public_history_cursors.account_id
                AND silver_cursor.silver_dirty_since IS NOT NULL
          )
          AND (
              SELECT COUNT(*)
              FROM bronze_public_history_cursors bronze_cursor
              WHERE bronze_cursor.account_id = gold_public_history_cursors.account_id
                AND bronze_cursor.source IN (
                    'nearblocks_ft'::public_history_source,
                    'nearblocks_mt'::public_history_source,
                    'nearblocks_receipt'::public_history_source
                )
                AND bronze_cursor.backfill_done = true
          ) = 3
        ORDER BY COALESCE(gold_dirty_since, updated_at) ASC, account_id ASC
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn earliest_silver_time(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(block_time)
        FROM silver_public_transfer_legs
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
}

pub async fn has_gold_before(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM gold_public_history_events
            WHERE dao_id = $1
              AND event_time < $2
        )
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

pub async fn earliest_pending_exchange_time(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        SELECT MIN(COALESCE(l.block_time, g.event_time))
        FROM gold_public_history_events g
        LEFT JOIN silver_public_transfer_legs l
          ON l.id = g.primary_transfer_leg_id
        WHERE g.dao_id = $1
          AND g.transaction_type = 'exchange'
          AND g.status = 'pending'
        "#,
    )
    .bind(dao_id)
    .fetch_one(&mut **tx)
    .await
}

/// Widen a suffix boundary until it no longer bisects any completed exchange.
///
/// Either leg may occur first, and widening for one exchange can expose an
/// overlapping exchange that did not cross the original boundary. Iterate to
/// a fixed point so every exchange included in the suffix is replayed whole.
pub async fn widen_for_overlapping_completed_exchanges(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<DateTime<Utc>, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        WITH RECURSIVE exchange_intervals AS (
            SELECT
                LEAST(primary_leg.block_time, counter_leg.block_time) AS starts_at,
                GREATEST(primary_leg.block_time, counter_leg.block_time) AS ends_at
            FROM gold_public_history_events gold
            JOIN silver_public_transfer_legs primary_leg
              ON primary_leg.id = gold.primary_transfer_leg_id
            JOIN silver_public_transfer_legs counter_leg
              ON counter_leg.id = gold.counter_transfer_leg_id
            WHERE gold.dao_id = $1
              AND gold.transaction_type = 'exchange'
        ), boundaries(boundary) AS (
            SELECT $2::timestamptz
            UNION
            SELECT interval.starts_at
            FROM boundaries current
            JOIN exchange_intervals interval
              ON interval.starts_at < current.boundary
             AND interval.ends_at >= current.boundary
        )
        SELECT MIN(boundary)
        FROM boundaries
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .fetch_one(&mut **tx)
    .await
}

/// Loads absolute balance stamps for every ledger movement in the recompute
/// window. One batched read per projection pass; stamps are absolute values,
/// so partial recomputes need no seeding.
pub async fn load_balance_stamps(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<BalanceStamps, sqlx::Error> {
    let rows = sqlx::query_as::<_, BalanceStampRow>(
        r#"
        SELECT entry_key, token_standard::text AS token_standard, receipt_id,
               balance_before, balance_after
        FROM silver_balance_history
        WHERE account_id = $1
          AND block_time >= $2
        "#,
    )
    .bind(account_id)
    .bind(recompute_from)
    .fetch_all(&mut **tx)
    .await?;
    Ok(BalanceStamps::from_rows(rows))
}

pub async fn load_silver_suffix(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
    recompute_from: DateTime<Utc>,
) -> Result<Vec<SilverTransferLegRow>, sqlx::Error> {
    let sql = format!(
        r#"
        SELECT
            l.id,
            l.account_id,
            l.leg_key,
            COALESCE(l.proposal_ref, dp.id) AS proposal_ref,
            COALESCE(l.proposal_id, dp.proposal_id) AS proposal_id,
            l.transaction_hash,
            l.receipt_id,
            l.block_height,
            l.block_time,
            l.token_standard::text AS token_standard,
            l.token_id,
            l.direction::text AS direction,
            l.counterparty,
            l.amount_raw,
            l.amount,
            l.decimals,
            l.leg_kind::text AS leg_kind,
            l.raw_payload,
            dp.status::text AS proposal_status,
            dp.proposal_created_at,
            dp.proposal_executed_at,
            dp.proposal_execution_block_height,
            dp.proposal_execution_transaction_hash,
            dp.quote_metadata,
            dp.quote_deposit_address
        FROM silver_public_transfer_legs l
        LEFT JOIN LATERAL (
            SELECT matched.id, matched.proposal_id
            FROM (
                SELECT
                    dp.id,
                    dp.proposal_id,
                    COUNT(*) OVER () AS match_count
                FROM dao_proposals dp
                WHERE l.proposal_ref IS NULL
                  AND dp.proposal_executed_at IS NOT NULL
                  AND {QUOTE_LEG_MATCH_SQL}
            ) matched
            WHERE matched.match_count = 1
        ) fallback_dp ON TRUE
        LEFT JOIN dao_proposals dp
          ON dp.id = COALESCE(l.proposal_ref, fallback_dp.id)
        WHERE l.account_id = $1
          AND l.block_time >= $2
        ORDER BY l.block_time ASC, l.block_height ASC, l.id ASC
        "#
    );
    sqlx::query_as::<_, SilverTransferLegRow>(&sql)
        .bind(account_id)
        .bind(recompute_from)
        .fetch_all(&mut **tx)
        .await
}

pub async fn upsert_gold_event(
    tx: &mut Transaction<'_, Postgres>,
    event: &GoldPublicHistoryEvent,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_public_history_events (
            gold_event_key,
            primary_transfer_leg_id,
            counter_transfer_leg_id,
            proposal_ref,
            dao_id,
            transaction_type,
            token_in,
            token_out,
            amount_in,
            amount_out,
            amount_in_usd,
            amount_out_usd,
            usd_change,
            token_in_balance_before,
            token_in_balance_after,
            token_out_balance_before,
            token_out_balance_after,
            recipient,
            counterparty,
            refund_to,
            transaction_hash,
            receipt_id,
            block_height,
            event_time,
            proposal_id,
            proposal_status,
            proposal_created_at,
            proposal_executed_at,
            proposal_execution_block_height,
            proposal_execution_transaction_hash,
            status,
            raw_payload
        )
        VALUES (
            $1, $2, $3, $4, $5, $6::public_transaction_type, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26::proposal_status,
            $27, $28, $29, $30, $31::public_history_event_status, $32
        )
        ON CONFLICT (gold_event_key) DO UPDATE SET
            primary_transfer_leg_id = EXCLUDED.primary_transfer_leg_id,
            counter_transfer_leg_id = EXCLUDED.counter_transfer_leg_id,
            proposal_ref = EXCLUDED.proposal_ref,
            dao_id = EXCLUDED.dao_id,
            transaction_type = EXCLUDED.transaction_type,
            token_in = EXCLUDED.token_in,
            token_out = EXCLUDED.token_out,
            amount_in = EXCLUDED.amount_in,
            amount_out = EXCLUDED.amount_out,
            amount_in_usd = CASE
                WHEN gold_public_history_events.token_in IS NOT DISTINCT FROM EXCLUDED.token_in
                 AND gold_public_history_events.amount_in IS NOT DISTINCT FROM EXCLUDED.amount_in
                 AND gold_public_history_events.event_time = EXCLUDED.event_time
                THEN COALESCE(EXCLUDED.amount_in_usd, gold_public_history_events.amount_in_usd)
                ELSE EXCLUDED.amount_in_usd
            END,
            amount_out_usd = CASE
                WHEN gold_public_history_events.token_out IS NOT DISTINCT FROM EXCLUDED.token_out
                 AND gold_public_history_events.amount_out IS NOT DISTINCT FROM EXCLUDED.amount_out
                 AND gold_public_history_events.event_time = EXCLUDED.event_time
                THEN COALESCE(EXCLUDED.amount_out_usd, gold_public_history_events.amount_out_usd)
                ELSE EXCLUDED.amount_out_usd
            END,
            usd_change = EXCLUDED.usd_change,
            token_in_balance_before = EXCLUDED.token_in_balance_before,
            token_in_balance_after = EXCLUDED.token_in_balance_after,
            token_out_balance_before = EXCLUDED.token_out_balance_before,
            token_out_balance_after = EXCLUDED.token_out_balance_after,
            recipient = EXCLUDED.recipient,
            counterparty = EXCLUDED.counterparty,
            refund_to = EXCLUDED.refund_to,
            transaction_hash = EXCLUDED.transaction_hash,
            receipt_id = EXCLUDED.receipt_id,
            block_height = EXCLUDED.block_height,
            event_time = EXCLUDED.event_time,
            proposal_id = EXCLUDED.proposal_id,
            proposal_status = EXCLUDED.proposal_status,
            proposal_created_at = EXCLUDED.proposal_created_at,
            proposal_executed_at = EXCLUDED.proposal_executed_at,
            proposal_execution_block_height = EXCLUDED.proposal_execution_block_height,
            proposal_execution_transaction_hash = EXCLUDED.proposal_execution_transaction_hash,
            status = EXCLUDED.status,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(&event.gold_event_key)
    .bind(event.primary_transfer_leg_id)
    .bind(event.counter_transfer_leg_id)
    .bind(event.proposal_ref)
    .bind(&event.dao_id)
    .bind(event.transaction_type.as_str())
    .bind(&event.token_in)
    .bind(&event.token_out)
    .bind(&event.amount_in)
    .bind(&event.amount_out)
    .bind(&event.amount_in_usd)
    .bind(&event.amount_out_usd)
    .bind(&event.usd_change)
    .bind(&event.token_in_balance_before)
    .bind(&event.token_in_balance_after)
    .bind(&event.token_out_balance_before)
    .bind(&event.token_out_balance_after)
    .bind(&event.recipient)
    .bind(&event.counterparty)
    .bind(&event.refund_to)
    .bind(&event.transaction_hash)
    .bind(&event.receipt_id)
    .bind(event.block_height)
    .bind(event.event_time)
    .bind(event.proposal_id)
    .bind(&event.proposal_status)
    .bind(event.proposal_created_at)
    .bind(event.proposal_executed_at)
    .bind(event.proposal_execution_block_height)
    .bind(&event.proposal_execution_transaction_hash)
    .bind(event.status.as_str())
    .bind(&event.raw_payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn clear_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    transfer_leg_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        DELETE FROM gold_public_history_projection_errors
        WHERE transfer_leg_id = $1
        "#,
    )
    .bind(transfer_leg_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn upsert_projection_error(
    tx: &mut Transaction<'_, Postgres>,
    transfer_leg_id: i64,
    dao_id: &str,
    reason: &str,
    raw_payload: &Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gold_public_history_projection_errors (
            transfer_leg_id,
            dao_id,
            reason,
            raw_payload
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (transfer_leg_id) DO UPDATE SET
            dao_id = EXCLUDED.dao_id,
            reason = EXCLUDED.reason,
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        "#,
    )
    .bind(transfer_leg_id)
    .bind(dao_id)
    .bind(reason)
    .bind(raw_payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn delete_stale_gold_rows(
    tx: &mut Transaction<'_, Postgres>,
    dao_id: &str,
    recompute_from: DateTime<Utc>,
    preserve_keys: &[String],
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        r#"
        DELETE FROM gold_public_history_events
        WHERE dao_id = $1
          AND EXISTS (
              SELECT 1
              FROM silver_public_transfer_legs leg
              WHERE leg.block_time >= $2
                AND leg.id IN (
                    gold_public_history_events.primary_transfer_leg_id,
                    gold_public_history_events.counter_transfer_leg_id
                )
          )
          AND NOT (gold_event_key = ANY($3))
        "#,
    )
    .bind(dao_id)
    .bind(recompute_from)
    .bind(preserve_keys)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}


#[allow(dead_code)]
pub fn zero() -> BigDecimal {
    BigDecimal::from(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use sqlx::PgPool;

    const DAO_ID: &str = "gold-reconciliation-test.sputnik-dao.near";

    async fn insert_silver_leg(
        pool: &PgPool,
        key: &str,
        token_id: &str,
        direction: &str,
        block_height: i64,
        block_time: DateTime<Utc>,
    ) -> sqlx::Result<i64> {
        let source_event_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO bronze_public_history_events (
                account_id,
                source,
                source_event_key,
                block_height,
                block_timestamp,
                block_time,
                affected_account_id,
                token_id,
                raw_payload
            )
            VALUES ($1, 'nearblocks_ft', $2, $3, $4, $5, $1, $6, '{}'::jsonb)
            RETURNING id
            "#,
        )
        .bind(DAO_ID)
        .bind(key)
        .bind(block_height)
        .bind(block_time.timestamp_nanos_opt().expect("valid test time"))
        .bind(block_time)
        .bind(token_id)
        .fetch_one(pool)
        .await?;

        sqlx::query_scalar(
            r#"
            INSERT INTO silver_public_transfer_legs (
                account_id,
                leg_key,
                source_event_id,
                source,
                block_height,
                block_time,
                token_standard,
                token_id,
                direction,
                amount_raw,
                amount,
                decimals,
                leg_kind,
                raw_payload
            )
            VALUES (
                $1, $2, $3, 'nearblocks_ft', $4, $5, 'nep141', $6,
                $7::public_transfer_direction, 1, 1, 0, 'transfer', '{}'::jsonb
            )
            RETURNING id
            "#,
        )
        .bind(DAO_ID)
        .bind(key)
        .bind(source_event_id)
        .bind(block_height)
        .bind(block_time)
        .bind(token_id)
        .bind(direction)
        .fetch_one(pool)
        .await
    }

    async fn insert_completed_exchange(
        pool: &PgPool,
        key: &str,
        primary_leg_id: i64,
        counter_leg_id: i64,
        event_time: DateTime<Utc>,
    ) -> sqlx::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO gold_public_history_events (
                gold_event_key,
                primary_transfer_leg_id,
                counter_transfer_leg_id,
                dao_id,
                transaction_type,
                token_in,
                token_out,
                amount_in,
                amount_out,
                token_in_balance_before,
                token_in_balance_after,
                token_out_balance_before,
                token_out_balance_after,
                event_time,
                status,
                raw_payload
            )
            VALUES (
                $1, $2, $3, $4, 'exchange', 'token-in.near', 'token-out.near',
                1, 1, 0, 1, 1, 0, $5, 'success', '{}'::jsonb
            )
            "#,
        )
        .bind(key)
        .bind(primary_leg_id)
        .bind(counter_leg_id)
        .bind(DAO_ID)
        .bind(event_time)
        .execute(pool)
        .await?;
        Ok(())
    }

    #[sqlx::test]
    async fn completed_exchange_boundary_handles_incoming_before_outgoing(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let incoming_time = Utc.with_ymd_and_hms(2026, 7, 20, 9, 0, 0).unwrap();
        let outgoing_time = Utc.with_ymd_and_hms(2026, 7, 20, 9, 1, 0).unwrap();
        let incoming_leg = insert_silver_leg(
            &pool,
            "reverse-incoming",
            "token-in.near",
            "incoming",
            10,
            incoming_time,
        )
        .await?;
        let outgoing_leg = insert_silver_leg(
            &pool,
            "reverse-outgoing",
            "token-out.near",
            "outgoing",
            20,
            outgoing_time,
        )
        .await?;
        insert_completed_exchange(
            &pool,
            "reverse-exchange",
            outgoing_leg,
            incoming_leg,
            outgoing_time,
        )
        .await?;

        let mut tx = pool.begin().await?;
        let boundary =
            widen_for_overlapping_completed_exchanges(&mut tx, DAO_ID, outgoing_time).await?;
        tx.rollback().await?;

        assert_eq!(boundary, incoming_time);
        Ok(())
    }

    #[sqlx::test]
    async fn completed_exchange_boundary_reaches_transitive_fixed_point(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let first_outgoing_time = Utc.with_ymd_and_hms(2026, 7, 20, 10, 0, 0).unwrap();
        let second_outgoing_time = Utc.with_ymd_and_hms(2026, 7, 20, 10, 1, 0).unwrap();
        let first_incoming_time = Utc.with_ymd_and_hms(2026, 7, 20, 10, 2, 0).unwrap();
        let second_incoming_time = Utc.with_ymd_and_hms(2026, 7, 20, 10, 3, 0).unwrap();

        let first_outgoing = insert_silver_leg(
            &pool,
            "transitive-first-outgoing",
            "token-out-a.near",
            "outgoing",
            10,
            first_outgoing_time,
        )
        .await?;
        let second_outgoing = insert_silver_leg(
            &pool,
            "transitive-second-outgoing",
            "token-out-b.near",
            "outgoing",
            20,
            second_outgoing_time,
        )
        .await?;
        let first_incoming = insert_silver_leg(
            &pool,
            "transitive-first-incoming",
            "token-in-a.near",
            "incoming",
            30,
            first_incoming_time,
        )
        .await?;
        let second_incoming = insert_silver_leg(
            &pool,
            "transitive-second-incoming",
            "token-in-b.near",
            "incoming",
            40,
            second_incoming_time,
        )
        .await?;
        insert_completed_exchange(
            &pool,
            "transitive-first-exchange",
            first_outgoing,
            first_incoming,
            first_outgoing_time,
        )
        .await?;
        insert_completed_exchange(
            &pool,
            "transitive-second-exchange",
            second_outgoing,
            second_incoming,
            second_outgoing_time,
        )
        .await?;

        let mut tx = pool.begin().await?;
        let boundary =
            widen_for_overlapping_completed_exchanges(&mut tx, DAO_ID, second_incoming_time)
                .await?;
        tx.rollback().await?;

        assert_eq!(boundary, first_outgoing_time);
        Ok(())
    }

    #[sqlx::test]
    async fn balance_stamps_resolve_token_legs_by_key_and_native_by_receipt(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        let block_time = Utc.with_ymd_and_hms(2026, 7, 20, 9, 0, 0).unwrap();
        sqlx::query(
            r#"
            INSERT INTO silver_balance_history (
                account_id, asset, token_standard, entry_key, source,
                receipt_id, block_height, block_time, intra_block_seq,
                delta_raw, delta, decimals, balance_before, balance_after,
                affects_user_balance, user_balance_after
            )
            VALUES
                ($1, 'token.near', 'nep141', 'nearblocks_ft:ft-key', 'nearblocks_ft',
                 'r-token', 10, $2, 0, 1000000, 1, 6, 0, 1, TRUE, 1),
                ($1, 'near', 'native', 'native-entry', 'nearblocks_receipt',
                 'r-native', 10, $2, 1, 5, 5, 24, 2, 7, TRUE, 7)
            "#,
        )
        .bind(DAO_ID)
        .bind(block_time)
        .execute(&pool)
        .await?;

        let mut tx = pool.begin().await?;
        let stamps = load_balance_stamps(&mut tx, DAO_ID, block_time).await?;
        tx.rollback().await?;

        let token_leg = stamp_probe_leg("ft-leg", "nearblocks_ft:ft-key", "nep141", "r-other");
        let token_stamp = stamps.for_leg(&token_leg).expect("token stamp by leg_key");
        assert_eq!(token_stamp.balance_after, BigDecimal::from(1));

        let native_leg = stamp_probe_leg("native-leg", "some-other-key", "native", "r-native");
        let native_stamp = stamps
            .for_leg(&native_leg)
            .expect("native stamp by receipt_id");
        assert_eq!(native_stamp.balance_before, BigDecimal::from(2));
        assert_eq!(native_stamp.balance_after, BigDecimal::from(7));

        Ok(())
    }

    fn stamp_probe_leg(
        token_id: &str,
        leg_key: &str,
        token_standard: &str,
        receipt_id: &str,
    ) -> SilverTransferLegRow {
        SilverTransferLegRow {
            id: 1,
            account_id: DAO_ID.to_string(),
            leg_key: leg_key.to_string(),
            proposal_ref: None,
            proposal_id: None,
            transaction_hash: None,
            receipt_id: Some(receipt_id.to_string()),
            block_height: 10,
            block_time: Utc.with_ymd_and_hms(2026, 7, 20, 9, 0, 0).unwrap(),
            token_standard: token_standard.to_string(),
            token_id: token_id.to_string(),
            direction: "incoming".to_string(),
            counterparty: None,
            amount_raw: BigDecimal::from(1),
            amount: BigDecimal::from(1),
            decimals: 6,
            leg_kind: "transfer".to_string(),
            raw_payload: serde_json::json!({}),
            proposal_status: None,
            proposal_created_at: None,
            proposal_executed_at: None,
            proposal_execution_block_height: None,
            proposal_execution_transaction_hash: None,
            quote_metadata: None,
            quote_deposit_address: None,
        }
    }
}
