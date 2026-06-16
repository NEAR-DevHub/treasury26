//! Confidential deposit-amount corrections.
//!
//! The 1Click history API reports the ~0.001 quote nominal as the deposit
//! amount. This module records the real deposited quantity per gold deposit so
//! the projector can override it (gated by `CORRECT_CONFIDENTIAL_DEPOSIT_AMOUNTS`):
//!   - forward: a live 1Click balance fetch at ingest time, diffed against the
//!     DAO's previous gold balance for the token;
//!   - backfill: the poller's `balance_changes` deposit legs, paired to gold
//!     deposits per `(dao, token)` by time.

use std::collections::HashMap;
use std::str::FromStr;

use bigdecimal::{BigDecimal, Zero};
use chrono::{DateTime, Duration, Utc};
use near_account_id::AccountIdRef;
use sqlx::PgPool;

use crate::AppState;
use crate::constants::intents_tokens::get_defuse_tokens_map;
use crate::handlers::intents::confidential::balances::fetch_confidential_balances;
use crate::handlers::intents::confidential::gold::cursors::mark_gold_dirty;
use crate::handlers::intents::confidential::gold::history_events::{
    ConfidentialDepositLeg, GoldDeposit, latest_gold_token_balance, load_confidential_deposit_legs,
    load_confidential_gold_deposits, upsert_confidential_deposit_correction,
};
use crate::handlers::intents::confidential::types::ConfidentialDepositCorrectionSource;

/// A just-ingested external (origin-less) deposit bronze row eligible for a
/// forward live-fetch correction.
#[derive(Debug, Clone)]
pub(crate) struct InsertedConfidentialDeposit {
    pub(crate) history_event_id: i64,
    pub(crate) destination_asset: String,
    pub(crate) created_at_external: DateTime<Utc>,
}

/// Forward live balance reads can lag the deposit settlement; pad the gold
/// recompute window so the deposit's bronze row is re-projected.
const FORWARD_RECOMPUTE_MARGIN: Duration = Duration::minutes(10);

/// A backfill leg may be observed up to this long after the deposit's quote
/// time (poll lag); beyond it we treat the deposit as unmatched.
const LEG_MATCH_WINDOW: Duration = Duration::hours(6);

/// Two same-token deposits within this window collapse into one poller leg
/// (the merge case); the sibling without a leg is credited 0.
const MERGE_WINDOW: Duration = Duration::minutes(10);

/// Forward live-fetch only applies to genuinely-recent deposits. During bronze
/// ingest/backfill, historical rows are "newly inserted" too, but a live
/// balance read reflects *now*, not the historical moment — so a live-fetch on
/// them is wrong. Older deposits are left to the authoritative
/// `balance_changes` backfill.
const FORWARD_DEPOSIT_MAX_AGE: Duration = Duration::minutes(15);

/// Decimal scale (`10^decimals`) for a defuse asset, from the static token map.
fn token_scale(asset: &str) -> Option<BigDecimal> {
    let decimals = get_defuse_tokens_map().get(asset)?.decimals;
    Some((0..decimals).fold(BigDecimal::from(1u32), |acc, _| {
        acc * BigDecimal::from(10u32)
    }))
}

/// Pair one asset's time-ordered gold deposits against its time-ordered legs,
/// returning `(history_event_id, corrected_net_amount)` for the deposits to
/// correct. A deposit matches the next unconsumed leg observed within
/// `LEG_MATCH_WINDOW` after its quote time; a same-token sibling right after a
/// match (within `MERGE_WINDOW`) with no leg of its own is a merge-extra
/// credited 0; anything else (pre-poller / orphan) is omitted (left at the raw
/// API amount). Both inputs must be sorted by observed/quote time ascending.
fn pair_deposits_to_legs(
    deposits: &[GoldDeposit],
    legs: &[ConfidentialDepositLeg],
) -> Vec<(i64, BigDecimal)> {
    let mut leg_idx = 0usize;
    let mut prev_matched_quote: Option<DateTime<Utc>> = None;
    let mut corrected = Vec::new();

    for deposit in deposits {
        while leg_idx < legs.len() && legs[leg_idx].observed_at < deposit.quote_created_at {
            leg_idx += 1;
        }

        if leg_idx < legs.len()
            && legs[leg_idx].observed_at <= deposit.quote_created_at + LEG_MATCH_WINDOW
        {
            corrected.push((deposit.history_event_id, legs[leg_idx].amount.clone()));
            leg_idx += 1;
            prev_matched_quote = Some(deposit.quote_created_at);
        } else if prev_matched_quote
            .is_some_and(|prev| deposit.quote_created_at - prev <= MERGE_WINDOW)
        {
            corrected.push((deposit.history_event_id, BigDecimal::zero()));
            prev_matched_quote = Some(deposit.quote_created_at);
        } else {
            prev_matched_quote = None;
        }
    }

    corrected
}

/// Records real confidential deposit quantities into
/// `confidential_deposit_amount_corrections`.
pub(crate) struct ConfidentialDepositCorrector;

impl ConfidentialDepositCorrector {
    /// Forward path: for deposits just ingested into bronze, fetch the DAO's
    /// live 1Click balances and record `live_balance − previous_gold_balance`
    /// as the real quantity. Within a poll batch the earliest same-token
    /// deposit takes the full delta and any siblings take 0 (merge rule).
    /// Best-effort — callers log and continue on error.
    pub(crate) async fn correct_new_deposits(
        state: &AppState,
        account_id: &AccountIdRef,
        inserted: &[InsertedConfidentialDeposit],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if inserted.is_empty() {
            return Ok(());
        }

        // Only correct genuinely-recent deposits; historical rows ingested into
        // bronze are "newly inserted" too but must be left to the backfill.
        let cutoff = Utc::now() - FORWARD_DEPOSIT_MAX_AGE;
        let mut deposits_by_asset: HashMap<String, Vec<&InsertedConfidentialDeposit>> =
            HashMap::new();
        for deposit in inserted {
            if deposit.created_at_external < cutoff {
                continue;
            }
            deposits_by_asset
                .entry(deposit.destination_asset.clone())
                .or_default()
                .push(deposit);
        }
        if deposits_by_asset.is_empty() {
            return Ok(());
        }

        let live_balances = fetch_confidential_balances(state, account_id)
            .await
            .map_err(|(status, message)| {
                format!("live balance fetch failed ({status}): {message}")
            })?;
        let mut live_raw: HashMap<String, BigDecimal> = HashMap::new();
        for (asset, raw) in live_balances {
            match BigDecimal::from_str(&raw) {
                Ok(value) => {
                    live_raw.insert(asset, value);
                }
                Err(e) => tracing::warn!(
                    "[deposit-correction] {} unparseable live balance '{}': {}",
                    account_id,
                    raw,
                    e
                ),
            }
        }

        let pool = &state.db_pool;
        let mut earliest_corrected: Option<DateTime<Utc>> = None;

        for (asset, mut deposits) in deposits_by_asset {
            deposits.sort_by_key(|d| (d.created_at_external, d.history_event_id));

            let Some(scale) = token_scale(&asset) else {
                tracing::warn!(
                    "[deposit-correction] {} unknown defuse asset {}, skipping",
                    account_id,
                    asset
                );
                continue;
            };
            let Some(raw_live) = live_raw.get(&asset) else {
                tracing::warn!(
                    "[deposit-correction] {} no live balance for {}, skipping",
                    account_id,
                    asset
                );
                continue;
            };

            let live_net = raw_live / &scale;
            let previous = latest_gold_token_balance(pool, account_id.as_str(), &asset)
                .await?
                .unwrap_or_else(BigDecimal::zero);
            let delta = &live_net - &previous;
            if delta <= BigDecimal::zero() {
                tracing::warn!(
                    "[deposit-correction] {} {} non-positive delta {} (live {} prev {}), skipping",
                    account_id,
                    asset,
                    delta,
                    live_net,
                    previous
                );
                continue;
            }

            for (idx, deposit) in deposits.iter().enumerate() {
                let (net, raw) = if idx == 0 {
                    (delta.clone(), &delta * &scale)
                } else {
                    (BigDecimal::zero(), BigDecimal::zero())
                };
                upsert_confidential_deposit_correction(
                    pool,
                    deposit.history_event_id,
                    &raw,
                    &net,
                    ConfidentialDepositCorrectionSource::LiveFetch,
                )
                .await?;
                earliest_corrected = Some(match earliest_corrected {
                    Some(current) => current.min(deposit.created_at_external),
                    None => deposit.created_at_external,
                });
            }
        }

        if let Some(earliest) = earliest_corrected {
            mark_gold_dirty(
                pool,
                account_id.as_str(),
                Some(earliest - FORWARD_RECOMPUTE_MARGIN),
            )
            .await?;
        }

        Ok(())
    }

    /// Backfill path: pair this DAO's external gold deposits with the poller's
    /// deposit legs (per asset, time-ordered) and record the legs' real
    /// amounts. Returns the number of corrections written.
    pub(crate) async fn reconcile_dao(pool: &PgPool, dao_id: &str) -> Result<usize, sqlx::Error> {
        let gold_deposits = load_confidential_gold_deposits(pool, dao_id).await?;
        if gold_deposits.is_empty() {
            return Ok(0);
        }
        let legs = load_confidential_deposit_legs(pool, dao_id).await?;

        let mut gold_by_asset: HashMap<String, Vec<GoldDeposit>> = HashMap::new();
        for deposit in gold_deposits {
            gold_by_asset
                .entry(deposit.asset.clone())
                .or_default()
                .push(deposit);
        }
        let mut legs_by_asset: HashMap<String, Vec<ConfidentialDepositLeg>> = HashMap::new();
        for leg in legs {
            legs_by_asset
                .entry(leg.asset.clone())
                .or_default()
                .push(leg);
        }

        let mut written = 0usize;
        let mut earliest_corrected: Option<DateTime<Utc>> = None;
        for (asset, deposits) in gold_by_asset {
            let Some(scale) = token_scale(&asset) else {
                tracing::warn!(
                    "[deposit-correction] {} unknown defuse asset {}, skipping backfill",
                    dao_id,
                    asset
                );
                continue;
            };
            let quote_by_id: HashMap<i64, DateTime<Utc>> = deposits
                .iter()
                .map(|d| (d.history_event_id, d.quote_created_at))
                .collect();
            let asset_legs = legs_by_asset.get(&asset).map(Vec::as_slice).unwrap_or(&[]);
            for (history_event_id, net) in pair_deposits_to_legs(&deposits, asset_legs) {
                let raw = &net * &scale;
                upsert_confidential_deposit_correction(
                    pool,
                    history_event_id,
                    &raw,
                    &net,
                    ConfidentialDepositCorrectionSource::BalanceChanges,
                )
                .await?;
                written += 1;
                if let Some(quote) = quote_by_id.get(&history_event_id) {
                    earliest_corrected = Some(match earliest_corrected {
                        Some(current) => current.min(*quote),
                        None => *quote,
                    });
                }
            }
        }

        // Backfill corrections are written here but the daily mark-dirty pass
        // only re-projects new/empty/already-dirty DAOs, so an already-projected
        // DAO would never pick them up. Mark gold dirty from the earliest
        // corrected deposit (mirroring the live-fetch path) so the projector
        // replays the window and applies the corrected amounts.
        if let Some(earliest) = earliest_corrected {
            mark_gold_dirty(pool, dao_id, Some(earliest - FORWARD_RECOMPUTE_MARGIN)).await?;
        }

        Ok(written)
    }

    /// Run the backfill for every enabled confidential DAO whose bronze history
    /// backfill is complete. Best-effort per DAO.
    pub(crate) async fn reconcile_backfilled_daos(pool: &PgPool) -> Result<usize, sqlx::Error> {
        let dao_ids: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT ma.account_id
            FROM monitored_accounts ma
            JOIN bronze_confidential_history_cursors bchc
                ON bchc.account_id = ma.account_id
               AND bchc.backfill_done = true
            WHERE ma.enabled = true
              AND ma.is_confidential_account = true
            "#,
        )
        .fetch_all(pool)
        .await?;

        let mut total = 0usize;
        for dao_id in dao_ids {
            match Self::reconcile_dao(pool, &dao_id).await {
                Ok(written) => total += written,
                Err(e) => {
                    tracing::error!("[deposit-correction] backfill failed for {}: {}", dao_id, e)
                }
            }
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    const ASSET: &str = "nep141:wrap.near";

    fn at(minute: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + Duration::minutes(minute)
    }

    fn gold(history_event_id: i64, quote_minute: i64) -> GoldDeposit {
        GoldDeposit {
            history_event_id,
            asset: ASSET.to_string(),
            quote_created_at: at(quote_minute),
        }
    }

    fn leg(observed_minute: i64, amount: &str) -> ConfidentialDepositLeg {
        ConfidentialDepositLeg {
            asset: ASSET.to_string(),
            observed_at: at(observed_minute),
            amount: BigDecimal::from_str(amount).unwrap(),
        }
    }

    #[test]
    fn one_to_one_match_uses_leg_amount() {
        let pairs = pair_deposits_to_legs(&[gold(1, 0)], &[leg(2, "5")]);
        assert_eq!(pairs, vec![(1, BigDecimal::from(5))]);
    }

    #[test]
    fn merge_credits_first_full_second_zero() {
        // Two deposits 1 min apart collapse into one combined poller leg.
        let pairs = pair_deposits_to_legs(&[gold(1, 0), gold(2, 1)], &[leg(3, "8")]);
        assert_eq!(
            pairs,
            vec![(1, BigDecimal::from(8)), (2, BigDecimal::zero())]
        );
    }

    #[test]
    fn pre_poller_deposit_left_uncorrected() {
        // The only leg is ~10h later (beyond LEG_MATCH_WINDOW) with no prior match.
        let pairs = pair_deposits_to_legs(&[gold(1, 0)], &[leg(600, "5")]);
        assert!(pairs.is_empty());
    }

    #[test]
    fn unmatched_second_far_from_match_not_merged() {
        // First matches; second is 1h later (beyond MERGE_WINDOW) with no leg → omitted.
        let pairs = pair_deposits_to_legs(&[gold(1, 0), gold(2, 60)], &[leg(2, "5")]);
        assert_eq!(pairs, vec![(1, BigDecimal::from(5))]);
    }

    /// On-demand backfill trigger / diagnostic — hits the local DB. Run with:
    ///   cargo test --lib confidential_backfill_against_db -- --ignored --nocapture
    /// Prints per-DAO correction counts (and any per-DAO error), so you can
    /// re-run the backfill without restarting the whole app.
    #[tokio::test]
    #[ignore = "hits the local DB; run explicitly with --ignored"]
    async fn confidential_backfill_against_db() {
        dotenvy::from_filename(".env").ok();
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = sqlx::PgPool::connect(&url).await.expect("connect");

        let before: i64 =
            sqlx::query_scalar("SELECT count(*) FROM confidential_deposit_amount_corrections")
                .fetch_one(&pool)
                .await
                .unwrap();
        println!("corrections before: {before}");

        let daos: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT ma.account_id
            FROM monitored_accounts ma
            JOIN bronze_confidential_history_cursors bchc
                ON bchc.account_id = ma.account_id AND bchc.backfill_done = true
            WHERE ma.enabled = true AND ma.is_confidential_account = true
            "#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("backfilled confidential DAOs: {}", daos.len());

        let mut total = 0usize;
        for dao in &daos {
            match ConfidentialDepositCorrector::reconcile_dao(&pool, dao).await {
                Ok(n) => {
                    if n > 0 {
                        println!("  {dao}: wrote {n}");
                    }
                    total += n;
                }
                Err(e) => println!("  {dao}: ERROR {e}"),
            }
        }

        let after: i64 =
            sqlx::query_scalar("SELECT count(*) FROM confidential_deposit_amount_corrections")
                .fetch_one(&pool)
                .await
                .unwrap();
        println!("total reconcile_dao wrote: {total}; corrections after: {after}");

        // Apply the corrections: reconcile_dao marked the DAOs gold-dirty, so
        // project them now (mirrors the reconciliation pass) instead of waiting
        // for the app's next cycle.
        let stats = crate::handlers::intents::confidential::gold::history_events::project_confidential_gold_for_dirty_daos(&pool, 8)
            .await
            .unwrap();
        println!(
            "projected: seen={} projected={} rows={} deleted={} errors={}",
            stats.accounts_seen,
            stats.accounts_projected,
            stats.rows_projected,
            stats.rows_deleted,
            stats.errors_written
        );
    }
}
