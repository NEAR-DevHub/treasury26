use std::str::FromStr;

use bigdecimal::{
    BigDecimal,
    num_traits::{Signed, Zero},
};
use near_api::NetworkConfig;
use sqlx::PgPool;

use super::models::{
    AssetCheckOutcome, AssetLedgerHead, VerificationCheckKind, VerificationCycleStats,
    VerificationStatus, VerificationWatermark,
};
use super::repository::{
    insert_rebase_entry, load_asset_ledger_heads, load_gate_candidates,
    load_head_check_candidates, load_watermark, record_check_results, set_gate_status,
    set_head_check_result,
};
use crate::services::public_balance_reader::{
    get_public_balance_at_block, get_public_gross_native_balance_at_block,
};

const FAILED_RETRY_AFTER_HOURS: i64 = 6;
const WATERMARK_MAX_AGE_MINUTES: i64 = 15;

#[derive(Debug)]
pub struct VerificationError(String);

impl std::fmt::Display for VerificationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for VerificationError {}

impl From<sqlx::Error> for VerificationError {
    fn from(error: sqlx::Error) -> Self {
        Self(error.to_string())
    }
}

enum AccountGateOutcome {
    Passed,
    Failed,
    SkippedStaleWatermark,
}

/// Verifies the bronze-derived balance ledger against the chain. RPC is a
/// verification authority only: the ledger is never built from RPC reads,
/// but bounded native drift (contract gas rebates the receipt feed cannot
/// itemize) is absorbed by an explicit, append-only reconciliation rebase.
pub struct BalanceVerifier<'a> {
    pool: &'a PgPool,
    archival_network: &'a NetworkConfig,
    native_tolerance: BigDecimal,
}

impl<'a> BalanceVerifier<'a> {
    pub fn new(
        pool: &'a PgPool,
        archival_network: &'a NetworkConfig,
        native_tolerance_near: f64,
    ) -> Self {
        let native_tolerance = BigDecimal::from_str(&format!("{native_tolerance_near}"))
            .unwrap_or_else(|_| BigDecimal::from(0));
        Self {
            pool,
            archival_network,
            native_tolerance,
        }
    }

    pub async fn run_cycle(&self) -> Result<VerificationCycleStats, VerificationError> {
        let mut stats = VerificationCycleStats::default();

        for account_id in load_gate_candidates(self.pool, FAILED_RETRY_AFTER_HOURS).await? {
            stats.gates_run += 1;
            match self.verify_account_gate(&account_id, &mut stats).await {
                Ok(AccountGateOutcome::Passed) => stats.gates_passed += 1,
                Ok(AccountGateOutcome::Failed) => stats.gates_failed += 1,
                Ok(AccountGateOutcome::SkippedStaleWatermark) => {
                    stats.gates_skipped_stale_watermark += 1;
                }
                Err(error) => {
                    stats.gates_failed += 1;
                    tracing::warn!(
                        account_id,
                        error = %error,
                        "public balance verification gate errored"
                    );
                }
            }
        }

        for account_id in load_head_check_candidates(self.pool).await? {
            stats.head_checks_run += 1;
            match self.check_account_head(&account_id, &mut stats).await {
                Ok(true) => {}
                Ok(false) => stats.head_checks_failed += 1,
                Err(error) => {
                    stats.head_checks_failed += 1;
                    tracing::warn!(
                        account_id,
                        error = %error,
                        "public balance head check errored"
                    );
                }
            }
        }

        Ok(stats)
    }

    /// Event-driven first verification for one account, called right after
    /// its drain → silver → gold nudge chain so a new treasury reaches
    /// chart-ready in the same pass instead of waiting for the next cron
    /// sweep. Only runs when the projection is ready and the account has
    /// never been gated (passed accounts are done; failed accounts respect
    /// the cool-off). Returns whether the gate passed.
    pub async fn nudge_account_gate(&self, account_id: &str) -> Result<bool, VerificationError> {
        let eligible: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM gold_public_history_cursors gold_cursor
                LEFT JOIN public_balance_verification_cursors verification
                  ON verification.account_id = gold_cursor.account_id
                WHERE gold_cursor.account_id = $1
                  AND gold_cursor.projection_ready_at IS NOT NULL
                  AND (
                      verification.account_id IS NULL
                      OR verification.status = 'unverified'
                  )
            )
            "#,
        )
        .bind(account_id)
        .fetch_one(self.pool)
        .await?;
        if !eligible {
            return Ok(false);
        }

        let mut stats = VerificationCycleStats::default();
        Ok(matches!(
            self.verify_account_gate(account_id, &mut stats).await?,
            AccountGateOutcome::Passed
        ))
    }

    /// Full-history gate: every asset's ledger head must match chain at the
    /// coverage watermark, and no asset's running balance may ever have been
    /// negative. Only a passing account becomes chart-ready.
    async fn verify_account_gate(
        &self,
        account_id: &str,
        stats: &mut VerificationCycleStats,
    ) -> Result<AccountGateOutcome, VerificationError> {
        let Some(watermark) = self.fresh_watermark(account_id).await? else {
            return Ok(AccountGateOutcome::SkippedStaleWatermark);
        };

        let heads = load_asset_ledger_heads(self.pool, account_id).await?;
        let outcomes = self.check_assets(account_id, &heads, &watermark).await?;
        let all_passed = outcomes.iter().all(|outcome| outcome.passed);

        let mut tx = self.pool.begin().await?;
        record_check_results(
            &mut tx,
            account_id,
            VerificationCheckKind::BackfillGate,
            watermark.cutoff_block_height,
            &outcomes,
        )
        .await?;
        if all_passed {
            stats.rebases_written += self
                .rebase_within_tolerance(&mut tx, account_id, &heads, &outcomes, &watermark)
                .await?;
            set_gate_status(
                &mut tx,
                account_id,
                VerificationStatus::Passed,
                watermark.cutoff_block_height,
            )
            .await?;
        } else {
            set_gate_status(
                &mut tx,
                account_id,
                VerificationStatus::Failed,
                watermark.cutoff_block_height,
            )
            .await?;
            for outcome in outcomes.iter().filter(|outcome| !outcome.passed) {
                tracing::error!(
                    account_id,
                    asset = outcome.asset,
                    ledger_balance = %outcome.ledger_balance,
                    chain_balance = %outcome.chain_balance,
                    drift = %outcome.drift,
                    min_running_balance = %outcome.min_running_balance,
                    "public balance verification FAILED; chart stays unavailable"
                );
            }
        }
        tx.commit().await?;

        Ok(if all_passed {
            AccountGateOutcome::Passed
        } else {
            AccountGateOutcome::Failed
        })
    }

    /// Head check after new events: drift is recorded and surfaces as a
    /// Stale chart, but never revokes a passed gate — RPC hiccups must not
    /// flap public charts.
    async fn check_account_head(
        &self,
        account_id: &str,
        stats: &mut VerificationCycleStats,
    ) -> Result<bool, VerificationError> {
        let Some(watermark) = self.fresh_watermark(account_id).await? else {
            return Ok(true);
        };

        let heads = load_asset_ledger_heads(self.pool, account_id).await?;
        let outcomes = self.check_assets(account_id, &heads, &watermark).await?;
        let all_passed = outcomes.iter().all(|outcome| outcome.passed);

        let mut tx = self.pool.begin().await?;
        record_check_results(
            &mut tx,
            account_id,
            VerificationCheckKind::HeadDrift,
            watermark.cutoff_block_height,
            &outcomes,
        )
        .await?;
        if all_passed {
            stats.rebases_written += self
                .rebase_within_tolerance(&mut tx, account_id, &heads, &outcomes, &watermark)
                .await?;
        } else {
            for outcome in outcomes.iter().filter(|outcome| !outcome.passed) {
                tracing::error!(
                    account_id,
                    asset = outcome.asset,
                    drift = %outcome.drift,
                    "public balance head drift beyond tolerance; chart marked stale"
                );
            }
        }
        set_head_check_result(
            &mut tx,
            account_id,
            watermark.cutoff_block_height,
            all_passed,
        )
        .await?;
        tx.commit().await?;

        Ok(all_passed)
    }

    async fn fresh_watermark(
        &self,
        account_id: &str,
    ) -> Result<Option<VerificationWatermark>, VerificationError> {
        let Some(watermark) = load_watermark(self.pool, account_id).await? else {
            return Ok(None);
        };
        let age = chrono::Utc::now() - watermark.refreshed_at;
        if age > chrono::Duration::minutes(WATERMARK_MAX_AGE_MINUTES) {
            return Ok(None);
        }
        Ok(Some(watermark))
    }

    async fn check_assets(
        &self,
        account_id: &str,
        heads: &[AssetLedgerHead],
        watermark: &VerificationWatermark,
    ) -> Result<Vec<AssetCheckOutcome>, VerificationError> {
        let mut outcomes = Vec::with_capacity(heads.len());
        for head in heads {
            // Coverage through the watermark plus no newer ledger events
            // means the head balance is the balance AT the watermark block.
            if head.head_block_height > watermark.cutoff_block_height {
                return Err(VerificationError(format!(
                    "ledger head {} is beyond coverage watermark {} for {}",
                    head.head_block_height, watermark.cutoff_block_height, account_id
                )));
            }
            // The ledger tracks gross owned NEAR; the display reader's
            // storage-net balance would show storage-sized phantom drift.
            let chain_balance = if head.token_standard == "native" {
                get_public_gross_native_balance_at_block(
                    self.archival_network,
                    account_id,
                    watermark.cutoff_block_height as u64,
                )
                .await
                .map_err(VerificationError)?
            } else {
                get_public_balance_at_block(
                    self.pool,
                    self.archival_network,
                    account_id,
                    &head.asset,
                    watermark.cutoff_block_height as u64,
                )
                .await
                .map_err(VerificationError)?
            };

            let drift = &chain_balance - &head.balance_after;
            let drift_ok = if head.token_standard == "native" {
                drift.abs() <= self.native_tolerance
            } else {
                drift.is_zero()
            };
            let passed = drift_ok
                && !head.min_balance_after.is_negative()
                && !head.min_user_balance_after.is_negative();
            outcomes.push(AssetCheckOutcome {
                asset: head.asset.clone(),
                ledger_balance: head.balance_after.clone(),
                chain_balance,
                drift,
                min_running_balance: head.min_balance_after.clone(),
                passed,
            });
        }
        Ok(outcomes)
    }

    /// Absorb passing-but-nonzero native drift with an explicit
    /// reconciliation entry so it cannot accumulate into a failure.
    async fn rebase_within_tolerance(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        account_id: &str,
        heads: &[AssetLedgerHead],
        outcomes: &[AssetCheckOutcome],
        watermark: &VerificationWatermark,
    ) -> Result<u64, VerificationError> {
        let mut written = 0;
        for outcome in outcomes {
            if !outcome.passed || outcome.drift.is_zero() {
                continue;
            }
            let Some(head) = heads.iter().find(|head| head.asset == outcome.asset) else {
                continue;
            };
            written += insert_rebase_entry(
                tx,
                account_id,
                &outcome.asset,
                &head.token_standard,
                watermark.cutoff_block_height,
                head.decimals,
                &outcome.ledger_balance,
                &outcome.chain_balance,
                &head.user_balance_after,
            )
            .await?;
        }
        Ok(written)
    }
}
