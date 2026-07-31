//! USD-value backfills that read the local `token_prices` series.
//!
//! Set-based stages fill NULL USD columns from the 5-minute price series (no
//! external API calls): `balance_changes.usd_value`, and `amount_in_usd` /
//! `amount_out_usd` on public and confidential gold history events. The gold
//! stages run after historical price loading in one ordered background job.
//! `usd_change` is left untouched — its semantics are event-type dependent
//! and quote-anchored where it exists.
//!
//! Pricing is one set-based pass per chunk: the chunk's rows are merged
//! with the price samples of their tokens, sorted by (token, time), and a
//! window function carries the last-seen price forward onto each row.
//! Per-row nearest-earlier index probes are avoided deliberately — they
//! merge-append across every monthly partition and are catastrophically
//! slow at this scale. Rows whose event predates the token's first sample
//! are filtered out up front, so every selected row prices and the chunk
//! loop can never wedge on a permanently unpriceable prefix.

use std::sync::Arc;

use sqlx::PgPool;

use super::service::TokenPriceService;

/// Rows updated per UPDATE statement; each iteration re-anchors on the
/// remaining NULLs, so the loop drains until a partial chunk comes back.
const CHUNK_SIZE: i64 = 50_000;
/// Runaway backstop far above any realistic table size / chunk count.
const MAX_CHUNKS_PER_RUN: usize = 10_000;

/// Fills `balance_changes.usd_value = abs(amount) * price` (amounts are
/// decimal-adjusted human values; see the 20251228 migration comment).
pub struct BalanceChangesUsdBackfill {
    inner: UsdBackfill,
}

/// Fills `gold_treasury_ledger_events.amount_in_usd / amount_out_usd` for
/// rows the projector left NULL (price was missing at projection time).
/// Hidden ledger rows are enriched too — they carry token/amount/event_time
/// like activity rows and would otherwise keep NULL USD forever.
pub struct GoldPublicUsdBackfill {
    inner: UsdBackfill,
}

/// Fills `gold_confidential_history_events.amount_in_usd / amount_out_usd`
/// for rows whose 1Click quote carried no nominal USD.
pub struct GoldConfidentialUsdBackfill {
    inner: UsdBackfill,
}

#[derive(Debug, Default)]
pub struct UsdBackfillSummary {
    pub rows_updated: u64,
    /// Distinct token ids that did not resolve to a registry token.
    pub tokens_skipped: usize,
    /// Candidate gold rows that still have no local historical price at or
    /// before their valuation timestamp.
    pub price_pending_rows: u64,
}

impl std::fmt::Display for UsdBackfillSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "rows_updated={} skipped_tokens={} price_pending_rows={} price_backfill_pending={}",
            self.rows_updated,
            self.tokens_skipped,
            self.price_pending_rows,
            self.price_pending_rows > 0
        )
    }
}

/// One target column to fill: how to select candidate rows and what to set.
struct UpdateSpec {
    /// Target table; must have `id` (bigint PK) and `updated_at` columns.
    table: &'static str,
    /// Raw token id of a candidate row, as an expression over alias `src`.
    token_expr: &'static str,
    /// Valuation timestamp, as an expression over alias `src`.
    time_expr: &'static str,
    /// Decimal-adjusted amount to multiply, as an expression over alias `src`.
    amount_expr: &'static str,
    /// NULL column to fill.
    target_col: &'static str,
    /// Extra AND-conditions on candidate rows (may be empty).
    extra_where: &'static str,
    /// Count and report mapped rows still waiting for historical prices.
    report_price_pending: bool,
}

impl UpdateSpec {
    /// Chunked carry-forward update. Binds: $1 raw ids, $2 token refs,
    /// $3 chunk limit.
    fn to_sql(&self) -> String {
        format!(
            r#"
            WITH mapping(raw_token_id, token_ref) AS (
                SELECT * FROM UNNEST($1::text[], $2::int4[])
            ),
            first_sample AS (
                SELECT token_ref, MIN(minute_at) AS first_at
                FROM token_prices
                GROUP BY token_ref
            ),
            todo AS (
                SELECT src.id, m.token_ref, {time_expr} AS valued_at,
                       {amount_expr} AS amount
                FROM {table} src
                JOIN mapping m ON m.raw_token_id = {token_expr}
                JOIN first_sample fs
                     ON fs.token_ref = m.token_ref AND fs.first_at <= {time_expr}
                WHERE src.{target_col} IS NULL {extra_where}
                ORDER BY src.id
                LIMIT $3
            ),
            merged AS (
                SELECT tp.token_ref, tp.minute_at AS at, 1 AS is_price,
                       tp.price_usd, NULL::bigint AS row_id, NULL::numeric AS amount
                FROM token_prices tp
                WHERE tp.token_ref IN (SELECT DISTINCT token_ref FROM todo)
                UNION ALL
                SELECT t.token_ref, t.valued_at, 0, NULL, t.id, t.amount
                FROM todo t
            ),
            numbered AS (
                SELECT token_ref, at, is_price, price_usd, row_id, amount,
                       COUNT(price_usd) OVER (
                           PARTITION BY token_ref
                           ORDER BY at, is_price DESC
                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                       ) AS grp
                FROM merged
            ),
            priced AS (
                SELECT row_id, amount,
                       FIRST_VALUE(price_usd) OVER (
                           PARTITION BY token_ref, grp
                           ORDER BY at, is_price DESC
                       ) AS price_usd
                FROM numbered
                WHERE grp > 0
            )
            UPDATE {table} src
            SET {target_col} = p.amount * p.price_usd,
                updated_at = NOW()
            FROM priced p
            WHERE src.id = p.row_id
              AND p.price_usd IS NOT NULL
              AND p.amount IS NOT NULL
            "#,
            table = self.table,
            token_expr = self.token_expr,
            time_expr = self.time_expr,
            amount_expr = self.amount_expr,
            target_col = self.target_col,
            extra_where = self.extra_where,
        )
    }

    /// Count still-NULL, mapped candidates that cannot be valued yet because
    /// no local price sample exists at or before the row's valuation time.
    fn pending_price_count_sql(&self) -> String {
        format!(
            r#"
            WITH mapping(raw_token_id, token_ref) AS (
                SELECT * FROM UNNEST($1::text[], $2::int4[])
            )
            SELECT COUNT(*)
            FROM {table} src
            JOIN mapping m ON m.raw_token_id = {token_expr}
            WHERE src.{target_col} IS NULL {extra_where}
              AND NOT EXISTS (
                  SELECT 1
                  FROM token_prices tp
                  WHERE tp.token_ref = m.token_ref
                    AND tp.minute_at <= {time_expr}
              )
            "#,
            table = self.table,
            token_expr = self.token_expr,
            time_expr = self.time_expr,
            target_col = self.target_col,
            extra_where = self.extra_where,
        )
    }
}

/// Shared machinery: token mapping + chunked drain loop over the specs.
struct UsdBackfill {
    pool: PgPool,
    service: Arc<TokenPriceService>,
    label: &'static str,
    /// One-column query returning the distinct raw token ids of the target.
    distinct_ids_sql: &'static str,
    specs: Vec<UpdateSpec>,
}

impl UsdBackfill {
    async fn run(&self) -> Result<UsdBackfillSummary, Box<dyn std::error::Error + Send + Sync>> {
        // A boot-time run can precede the ingest worker's first tick.
        if self.service.refresh_snapshot().await? == 0 {
            return Err(
                "tokens registry is empty; waiting for the ingest worker's first tick".into(),
            );
        }

        let raw_ids: Vec<(String,)> = sqlx::query_as(self.distinct_ids_sql)
            .fetch_all(&self.pool)
            .await?;

        let mut mapping_raw: Vec<String> = Vec::new();
        let mut mapping_ref: Vec<i32> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        for (raw,) in raw_ids {
            match self.service.token(&raw) {
                Some(record) => {
                    mapping_raw.push(raw);
                    mapping_ref.push(record.id);
                }
                None => skipped.push(raw),
            }
        }
        if !skipped.is_empty() {
            tracing::warn!(
                "{}: {} token ids not in registry: {:?}",
                self.label,
                skipped.len(),
                skipped
            );
        }

        let mut summary = UsdBackfillSummary {
            tokens_skipped: skipped.len(),
            ..Default::default()
        };
        if mapping_raw.is_empty() {
            return Ok(summary);
        }

        for spec in &self.specs {
            if spec.report_price_pending {
                let pending = sqlx::query_scalar::<_, i64>(&spec.pending_price_count_sql())
                    .bind(&mapping_raw)
                    .bind(&mapping_ref)
                    .fetch_one(&self.pool)
                    .await?
                    .max(0) as u64;
                summary.price_pending_rows += pending;
                if pending > 0 {
                    tracing::info!(
                        "{}: {} rows waiting for token price backfill before USD valuation",
                        self.label,
                        pending
                    );
                }
            }

            let sql = spec.to_sql();
            for _ in 0..MAX_CHUNKS_PER_RUN {
                let affected = sqlx::query(&sql)
                    .bind(&mapping_raw)
                    .bind(&mapping_ref)
                    .bind(CHUNK_SIZE)
                    .execute(&self.pool)
                    .await?
                    .rows_affected();
                summary.rows_updated += affected;
                if affected < CHUNK_SIZE as u64 {
                    break;
                }
                tracing::info!(
                    "{}: {} rows updated so far",
                    self.label,
                    summary.rows_updated
                );
            }
        }
        Ok(summary)
    }
}

impl BalanceChangesUsdBackfill {
    pub fn new(pool: PgPool, service: Arc<TokenPriceService>) -> Self {
        Self {
            inner: UsdBackfill {
                pool,
                service,
                label: "balance_changes usd backfill",
                distinct_ids_sql: r#"
                    SELECT DISTINCT COALESCE(token_id, 'near')
                    FROM balance_changes
                    WHERE usd_value IS NULL AND block_time IS NOT NULL
                "#,
                specs: vec![UpdateSpec {
                    table: "balance_changes",
                    token_expr: "COALESCE(src.token_id, 'near')",
                    time_expr: "src.block_time",
                    amount_expr: "ABS(src.amount)",
                    target_col: "usd_value",
                    extra_where: "AND src.block_time IS NOT NULL",
                    report_price_pending: false,
                }],
            },
        }
    }

    pub async fn run(
        &self,
    ) -> Result<UsdBackfillSummary, Box<dyn std::error::Error + Send + Sync>> {
        self.inner.run().await
    }
}

impl GoldPublicUsdBackfill {
    pub fn new(pool: PgPool, service: Arc<TokenPriceService>) -> Self {
        Self {
            inner: UsdBackfill {
                pool,
                service,
                label: "gold public usd backfill",
                distinct_ids_sql: r#"
                    SELECT DISTINCT token_in FROM gold_treasury_ledger_events
                    WHERE token_in IS NOT NULL AND amount_in_usd IS NULL
                    UNION
                    SELECT DISTINCT token_out FROM gold_treasury_ledger_events
                    WHERE token_out IS NOT NULL AND amount_out_usd IS NULL
                "#,
                specs: vec![
                    UpdateSpec {
                        table: "gold_treasury_ledger_events",
                        token_expr: "src.token_in",
                        time_expr: "src.event_time",
                        amount_expr: "src.amount_in",
                        target_col: "amount_in_usd",
                        extra_where: "AND src.amount_in IS NOT NULL",
                        report_price_pending: true,
                    },
                    UpdateSpec {
                        table: "gold_treasury_ledger_events",
                        token_expr: "src.token_out",
                        time_expr: "src.event_time",
                        amount_expr: "src.amount_out",
                        target_col: "amount_out_usd",
                        extra_where: "AND src.amount_out IS NOT NULL",
                        report_price_pending: true,
                    },
                ],
            },
        }
    }

    pub async fn run(
        &self,
    ) -> Result<UsdBackfillSummary, Box<dyn std::error::Error + Send + Sync>> {
        self.inner.run().await
    }
}

impl GoldConfidentialUsdBackfill {
    pub fn new(pool: PgPool, service: Arc<TokenPriceService>) -> Self {
        Self {
            inner: UsdBackfill {
                pool,
                service,
                label: "gold confidential usd backfill",
                distinct_ids_sql: r#"
                    SELECT DISTINCT origin_asset FROM gold_confidential_history_events
                    WHERE origin_asset IS NOT NULL AND amount_in_usd IS NULL
                    UNION
                    SELECT DISTINCT destination_asset FROM gold_confidential_history_events
                    WHERE amount_out_usd IS NULL
                "#,
                specs: vec![
                    UpdateSpec {
                        table: "gold_confidential_history_events",
                        token_expr: "src.origin_asset",
                        time_expr: "COALESCE(src.proposal_executed_at, src.quote_created_at)",
                        amount_expr: "src.amount_in",
                        target_col: "amount_in_usd",
                        extra_where: "AND src.amount_in IS NOT NULL",
                        report_price_pending: true,
                    },
                    UpdateSpec {
                        table: "gold_confidential_history_events",
                        token_expr: "src.destination_asset",
                        time_expr: "COALESCE(src.proposal_executed_at, src.quote_created_at)",
                        amount_expr: "src.amount_out",
                        target_col: "amount_out_usd",
                        extra_where: "",
                        report_price_pending: true,
                    },
                ],
            },
        }
    }

    pub async fn run(
        &self,
    ) -> Result<UsdBackfillSummary, Box<dyn std::error::Error + Send + Sync>> {
        self.inner.run().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bigdecimal::BigDecimal;
    use sqlx::PgPool;

    use super::*;

    #[test]
    fn spec_sql_interpolates_all_fields() {
        let spec = UpdateSpec {
            table: "balance_changes",
            token_expr: "COALESCE(src.token_id, 'near')",
            time_expr: "src.block_time",
            amount_expr: "ABS(src.amount)",
            target_col: "usd_value",
            extra_where: "AND src.block_time IS NOT NULL",
            report_price_pending: false,
        };
        let sql = spec.to_sql();
        assert!(sql.contains("UPDATE balance_changes src"));
        assert!(sql.contains("SET usd_value = p.amount * p.price_usd"));
        assert!(sql.contains("WHERE src.usd_value IS NULL AND src.block_time IS NOT NULL"));
        assert!(sql.contains("ABS(src.amount) AS amount"));
        assert!(!sql.contains('{'));
    }

    #[test]
    fn spec_pending_price_count_checks_for_prior_local_price() {
        let spec = UpdateSpec {
            table: "gold_treasury_ledger_events",
            token_expr: "src.token_in",
            time_expr: "src.event_time",
            amount_expr: "src.amount_in",
            target_col: "amount_in_usd",
            extra_where: "AND src.amount_in IS NOT NULL",
            report_price_pending: true,
        };
        let sql = spec.pending_price_count_sql();
        assert!(sql.contains("FROM gold_treasury_ledger_events src"));
        assert!(sql.contains("JOIN mapping m ON m.raw_token_id = src.token_in"));
        assert!(sql.contains("WHERE src.amount_in_usd IS NULL AND src.amount_in IS NOT NULL"));
        assert!(sql.contains("NOT EXISTS"));
        assert!(sql.contains("tp.minute_at <= src.event_time"));
        assert!(!sql.contains('{'));
    }

    #[test]
    fn summary_reports_price_backfill_pending() {
        let summary = UsdBackfillSummary {
            rows_updated: 7,
            tokens_skipped: 1,
            price_pending_rows: 3,
        };
        let rendered = summary.to_string();
        assert!(rendered.contains("rows_updated=7"));
        assert!(rendered.contains("skipped_tokens=1"));
        assert!(rendered.contains("price_pending_rows=3"));
        assert!(rendered.contains("price_backfill_pending=true"));
    }

    #[sqlx::test]
    async fn public_gold_backfill_fills_deferred_usd_amount(pool: PgPool) -> sqlx::Result<()> {
        let token_ref: i32 = sqlx::query_scalar(
            r#"
            INSERT INTO tokens (
                token_id, symbol, decimals, blockchain, contract_address,
                coingecko_id, price_usd, price_updated_at
            )
            VALUES (
                'nep141:wrap.near', 'wNEAR', 24, 'near', 'wrap.near',
                'near', 3.5, '2026-07-10 08:05:00+00'
            )
            RETURNING id
            "#,
        )
        .fetch_one(&pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO token_prices (token_ref, minute_at, price_usd)
            VALUES ($1, '2026-07-10 08:00:00+00', 3.5)
            "#,
        )
        .bind(token_ref)
        .execute(&pool)
        .await?;

        let source_event_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO bronze_public_history_events (
                account_id, source, source_event_key, block_height,
                block_timestamp, block_time, affected_account_id, raw_payload
            )
            VALUES (
                'usd-test.sputnik-dao.near', 'nearblocks_ft', 'usd-source', 1,
                1, '2026-07-10 08:03:00+00', 'usd-test.sputnik-dao.near', '{}'
            )
            RETURNING id
            "#,
        )
        .fetch_one(&pool)
        .await?;
        let leg_id: i64 = sqlx::query_scalar(
            r#"
            INSERT INTO silver_public_transfer_legs (
                account_id, leg_key, source_event_id, source, block_height,
                block_time, token_standard, token_id, direction, amount_raw,
                amount, decimals, leg_kind, raw_payload
            )
            VALUES (
                'usd-test.sputnik-dao.near', 'usd-leg', $1, 'nearblocks_ft', 1,
                '2026-07-10 08:03:00+00', 'nep141', 'wrap.near', 'incoming', 2,
                2, 24, 'transfer', '{}'
            )
            RETURNING id
            "#,
        )
        .bind(source_event_id)
        .fetch_one(&pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO monitored_accounts (account_id, enabled, is_confidential_account)
            VALUES ('usd-test.sputnik-dao.near', true, false)
            "#,
        )
        .execute(&pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO gold_treasury_ledger_events (
                gold_event_key, dao_id, source_kind, history_visible,
                transaction_type, status, event_time,
                token_in, amount_in, primary_transfer_leg_id
            )
            VALUES (
                'usd-gold', 'usd-test.sputnik-dao.near', 'public_silver_leg', TRUE,
                'deposit', 'success', '2026-07-10 08:03:00+00',
                'wrap.near', 2, $1
            )
            "#,
        )
        .bind(leg_id)
        .execute(&pool)
        .await?;

        let service = Arc::new(TokenPriceService::new(pool.clone()));
        service.refresh_snapshot().await?;
        assert_eq!(
            service.latest_price_for_recent_event("wrap.near", chrono::Utc::now()),
            Some("3.5".parse().expect("valid decimal"))
        );
        assert_eq!(
            service.latest_price_for_recent_event(
                "wrap.near",
                "2026-07-10T08:03:00Z".parse().expect("valid timestamp"),
            ),
            None
        );

        let summary = GoldPublicUsdBackfill::new(pool.clone(), service)
            .run()
            .await
            .expect("USD enrichment succeeds");
        assert_eq!(summary.rows_updated, 1);

        let amount_in_usd: Option<BigDecimal> = sqlx::query_scalar(
            "SELECT amount_in_usd FROM gold_treasury_ledger_events WHERE gold_event_key = 'usd-gold'",
        )
        .fetch_one(&pool)
        .await?;
        assert_eq!(amount_in_usd, Some("7.0".parse().expect("valid decimal")));

        Ok(())
    }
}
