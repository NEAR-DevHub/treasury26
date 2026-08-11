use std::str::FromStr;

use bigdecimal::{
    BigDecimal,
    num_traits::{Signed, Zero},
};
use chrono::{DateTime, Utc};
use near_api::NetworkConfig;
use sqlx::PgPool;

use super::models::{
    AssetCheckOutcome, AssetLedgerHead, VerificationCheckKind, VerificationCycleStats,
    VerificationStatus, VerificationWatermark,
};
use super::repository::{
    insert_rebase_entry, load_asset_ledger_heads, load_gate_candidates, load_head_check_candidates,
    load_native_ledger_head, load_native_ledger_head_tx, load_watermark, record_check_results,
    set_gate_status, set_head_check_result,
};
use crate::handlers::public_history::gold::unified::sync_hidden_ledger_rows;
use crate::services::public_balance_reader::{
    get_public_balance_at_block, get_public_gross_native_balance_at_block,
};

/// Cool-off before a failed gate re-verifies. Shared with the readiness
/// scheduler so coverage refreshes are only produced when the verifier can
/// consume them.
pub const FAILED_RETRY_AFTER_HOURS: i64 = 6;
/// Floor between failed-gate retries even when the ledger was rebuilt —
/// bounds RPC spend for accounts with constant activity.
pub const FAILED_RETRY_MIN_MINUTES: i64 = 15;
const WATERMARK_MAX_AGE_MINUTES: i64 = 15;
/// Contract accounts earn 30% of the gas fees burned by calls into them —
/// balance accretion the receipt feed cannot itemize (~0.0002 NEAR observed
/// per ledger event). The native drift budget scales with event count at
/// this rate so busy DAOs are not failed on accumulated gas rewards, while
/// the configured flat tolerance stays the floor for quiet accounts.
const NATIVE_DUST_PER_EVENT_NEAR: &str = "0.002";
/// Bound on archival head-anchor reads per silver cycle so a mass-dirty
/// event cannot turn one tick into an unbounded sequential RPC sweep.
const HEAD_ANCHORS_PER_CYCLE: usize = 25;

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
        // Unparseable config degrades to zero tolerance — the strict
        // direction (every nonzero drift fails), never a silent widening.
        let native_tolerance = BigDecimal::from_str(&format!("{native_tolerance_near}"))
            .unwrap_or_else(|error| {
                tracing::error!(
                    native_tolerance_near,
                    %error,
                    "invalid native verification tolerance; using zero"
                );
                BigDecimal::from(0)
            });
        Self {
            pool,
            archival_network,
            native_tolerance,
        }
    }

    pub async fn run_cycle(&self) -> Result<VerificationCycleStats, VerificationError> {
        let mut stats = VerificationCycleStats::default();

        for account_id in
            load_gate_candidates(self.pool, FAILED_RETRY_AFTER_HOURS, FAILED_RETRY_MIN_MINUTES)
                .await?
        {
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

    /// Event-driven verification for one account, called right after its
    /// drain → silver → gold nudge chain so a new treasury reaches
    /// chart-ready in the same pass instead of waiting for the next
    /// projection cycle. Runs when the projection is ready and the account
    /// was never gated, or a failed gate is retry-eligible (cool-off
    /// expired, or the ledger was rebuilt since the failed check, floored at
    /// the minimum retry interval). Returns whether the gate passed.
    pub async fn nudge_account_gate(&self, account_id: &str) -> Result<bool, VerificationError> {
        let eligible: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM gold_public_history_cursors gold_cursor
                LEFT JOIN public_balance_verification_cursors verification
                  ON verification.account_id = gold_cursor.account_id
                LEFT JOIN silver_public_history_cursors silver
                  ON silver.account_id = gold_cursor.account_id
                WHERE gold_cursor.account_id = $1
                  AND gold_cursor.projection_ready_at IS NOT NULL
                  AND (
                      verification.account_id IS NULL
                      OR verification.status = 'unverified'
                      OR (
                          verification.status = 'failed'
                          AND verification.updated_at
                                < NOW() - make_interval(mins => $3::integer)
                          AND (
                              verification.updated_at
                                    < NOW() - make_interval(hours => $2::integer)
                              OR silver.updated_at > verification.updated_at
                          )
                      )
                  )
            )
            "#,
        )
        .bind(account_id)
        .bind(FAILED_RETRY_AFTER_HOURS as i32)
        .bind(FAILED_RETRY_MIN_MINUTES as i32)
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

    /// Anchor every account whose ledger changed this silver cycle, capped
    /// per cycle. Returns how many heads were anchored; per-account errors
    /// are logged and skipped so one flaky archival read cannot stall the
    /// rest of the sweep.
    pub async fn anchor_changed_account_heads(&self, account_ids: &[String]) -> usize {
        let mut anchored = 0;
        for account_id in account_ids.iter().take(HEAD_ANCHORS_PER_CYCLE) {
            match self.anchor_native_head(account_id).await {
                Ok(true) => anchored += 1,
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    account_id,
                    error = %error,
                    "native head anchor check errored"
                ),
            }
        }
        if account_ids.len() > HEAD_ANCHORS_PER_CYCLE {
            tracing::warn!(
                total = account_ids.len(),
                cap = HEAD_ANCHORS_PER_CYCLE,
                "head anchor sweep capped; remaining accounts anchor on their next change or the hourly head check"
            );
        }
        anchored
    }

    /// Per-transaction head anchor for verified accounts: compare the
    /// native ledger head against chain at that exact block right after a
    /// live silver cycle changes the ledger. Bounded drift (gas rebates the
    /// receipt feed cannot itemize) is absorbed immediately by the same
    /// reconciliation rebase the hourly head check uses, instead of waiting
    /// for it; drift beyond tolerance marks the head check failed so the
    /// chart degrades to Stale. RPC stays a verification authority only —
    /// the user-owned series is never rewritten from chain reads. Untouched
    /// during initial builds: silver only projects after backfill completes,
    /// and unverified accounts are skipped so the full-history gate measures
    /// unanchored drift.
    pub async fn anchor_native_head(&self, account_id: &str) -> Result<bool, VerificationError> {
        let verified: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM public_balance_verification_cursors
                WHERE account_id = $1 AND status = 'passed'
            )
            "#,
        )
        .bind(account_id)
        .fetch_one(self.pool)
        .await?;
        if !verified {
            return Ok(false);
        }
        let Some((ledger_balance, user_balance, head_block)) =
            load_native_ledger_head(self.pool, account_id).await?
        else {
            return Ok(false);
        };

        let chain_balance = get_public_gross_native_balance_at_block(
            self.archival_network,
            account_id,
            head_block as u64,
        )
        .await
        .map_err(VerificationError)?;
        let drift = &chain_balance - &ledger_balance;
        if drift.is_zero() {
            return Ok(false);
        }

        let mut tx = self.pool.begin().await?;
        // The archival read happened outside any lock; a concurrent silver
        // recompute (nudge queue) may have rewritten the ledger since.
        // Serialize on the silver projection lock and re-verify the head is
        // the one that was measured — an anchor against a moved head would
        // sort as the new head with a balance from the wrong block.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("public-silver:{account_id}"))
            .execute(&mut *tx)
            .await?;
        let head_now = load_native_ledger_head_tx(&mut tx, account_id).await?;
        if head_now != Some((ledger_balance.clone(), user_balance.clone(), head_block)) {
            tx.rollback().await.ok();
            return Ok(false);
        }
        let anchored = if drift.abs() <= self.native_tolerance {
            let written = insert_rebase_entry(
                &mut tx,
                account_id,
                "near",
                "native",
                head_block,
                24,
                &ledger_balance,
                &chain_balance,
                &user_balance,
            )
            .await?;
            if written > 0 {
                sync_hidden_ledger_rows(&mut tx, account_id, DateTime::<Utc>::UNIX_EPOCH).await?;
                tracing::info!(
                    account_id,
                    head_block,
                    drift = %drift,
                    "native head anchored to chain within tolerance"
                );
            }
            written > 0
        } else {
            set_head_check_result(&mut tx, account_id, head_block, false).await?;
            tracing::error!(
                account_id,
                head_block,
                ledger_balance = %ledger_balance,
                chain_balance = %chain_balance,
                drift = %drift,
                "native head drift beyond tolerance at ledger head; chart marked stale"
            );
            false
        };
        tx.commit().await?;
        Ok(anchored)
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
            let rebases_written = self
                .rebase_within_tolerance(&mut tx, account_id, &heads, &outcomes, &watermark)
                .await?;
            if rebases_written > 0 {
                sync_hidden_ledger_rows(&mut tx, account_id, DateTime::<Utc>::UNIX_EPOCH).await?;
            }
            stats.rebases_written += rebases_written;
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
            let rebases_written = self
                .rebase_within_tolerance(&mut tx, account_id, &heads, &outcomes, &watermark)
                .await?;
            if rebases_written > 0 {
                sync_hidden_ledger_rows(&mut tx, account_id, DateTime::<Utc>::UNIX_EPOCH).await?;
            }
            stats.rebases_written += rebases_written;
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

    /// Allowed native drift for a ledger of `event_count` entries: the flat
    /// Sputnik DAO contract accounts hold no full-access keys, so they never
    /// sign transactions and their ledger is fully receipt-derivable. Any
    /// other monitored account can sign, which burns gas and moves deposits
    /// invisibly to the receipt feed — those are verified in anchored mode:
    /// trust chain at the first watermark, verify deltas forward.
    fn is_contract_treasury(account_id: &str) -> bool {
        account_id.ends_with(".sputnik-dao.near")
    }

    fn scaled_dust_budget(&self, event_count: i64) -> BigDecimal {
        let scaled = BigDecimal::from_str(NATIVE_DUST_PER_EVENT_NEAR)
            .expect("NATIVE_DUST_PER_EVENT_NEAR is a valid decimal")
            * BigDecimal::from(event_count.max(0));
        scaled.max(self.native_tolerance.clone())
    }

    /// Allowed native drift for one check, or None for the unbounded
    /// first-gate anchor of a signer-capable account (the rebase records the
    /// absorbed drift in the results, so anchor size stays auditable).
    ///
    /// Contract treasuries: gas rewards only ever ADD to a contract's chain
    /// balance, so only positive drift (chain above ledger) can be dust;
    /// negative drift means phantom inflows or missed outflows — a pipeline
    /// bug — and stays on the flat floor no matter how long the history is.
    /// Anchored accounts: gas spend from signing makes negative drift just
    /// as physical as positive, so the scaled budget applies symmetrically
    /// after the anchor.
    fn native_drift_budget(
        &self,
        account_id: &str,
        drift: &BigDecimal,
        head: &AssetLedgerHead,
    ) -> Option<BigDecimal> {
        if Self::is_contract_treasury(account_id) {
            if drift.is_negative() {
                return Some(self.native_tolerance.clone());
            }
            return Some(self.scaled_dust_budget(head.event_count));
        }
        if !head.has_anchor {
            return None;
        }
        Some(self.scaled_dust_budget(head.event_count))
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
                match self.native_drift_budget(account_id, &drift, head) {
                    Some(budget) => drift.abs() <= budget,
                    None => true,
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    const DAO: &str = "treasury.sputnik-dao.near";
    const SIGNER: &str = "meta-pool-dao-4.near";

    fn head(event_count: i64, has_anchor: bool) -> AssetLedgerHead {
        AssetLedgerHead {
            asset: "near".to_string(),
            token_standard: "native".to_string(),
            balance_after: BigDecimal::from(0),
            min_balance_after: BigDecimal::from(0),
            user_balance_after: BigDecimal::from(0),
            min_user_balance_after: BigDecimal::from(0),
            head_block_height: 0,
            decimals: 24,
            event_count,
            has_anchor,
        }
    }

    fn verifier_budget(
        account_id: &str,
        drift: &str,
        event_count: i64,
        has_anchor: bool,
    ) -> Option<BigDecimal> {
        let pool = sqlx::PgPool::connect_lazy("postgres://unused/unused").unwrap();
        let network = NetworkConfig::mainnet();
        let drift = BigDecimal::from_str(drift).unwrap();
        BalanceVerifier::new(&pool, &network, 0.1).native_drift_budget(
            account_id,
            &drift,
            &head(event_count, has_anchor),
        )
    }

    fn near(text: &str) -> Option<BigDecimal> {
        Some(BigDecimal::from_str(text).unwrap())
    }

    #[tokio::test]
    async fn drift_budget_floors_at_flat_tolerance_for_quiet_accounts() {
        assert_eq!(verifier_budget(DAO, "0.05", 0, false), near("0.1"));
        assert_eq!(verifier_budget(DAO, "0.05", 49, false), near("0.1"));
    }

    #[tokio::test]
    async fn drift_budget_scales_with_event_count_for_positive_drift() {
        assert_eq!(verifier_budget(DAO, "0.1", 50, false), near("0.100"));
        assert_eq!(verifier_budget(DAO, "0.15", 100, false), near("0.2"));
        assert_eq!(verifier_budget(DAO, "0.148", 1392, false), near("2.784"));
    }

    #[tokio::test]
    async fn negative_drift_never_scales_past_the_flat_floor() {
        // Gas rewards only add balance; ledger-above-chain is a bug, not dust.
        assert_eq!(verifier_budget(DAO, "-0.218", 640, false), near("0.1"));
        assert_eq!(verifier_budget(DAO, "-0.477", 252, false), near("0.1"));
    }

    #[tokio::test]
    async fn signer_account_first_gate_is_an_unbounded_anchor() {
        assert_eq!(verifier_budget(SIGNER, "-16.2092", 1222, false), None);
        assert_eq!(verifier_budget(SIGNER, "3.0", 296, false), None);
    }

    #[tokio::test]
    async fn anchored_signer_account_gets_the_symmetric_scaled_budget() {
        // Gas spend from signing makes negative drift physical here.
        assert_eq!(verifier_budget(SIGNER, "-0.4", 296, true), near("0.592"));
        assert_eq!(verifier_budget(SIGNER, "0.4", 296, true), near("0.592"));
        assert_eq!(verifier_budget(SIGNER, "-0.05", 10, true), near("0.1"));
    }
}
