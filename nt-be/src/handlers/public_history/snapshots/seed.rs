//! One-time historical seed from the trusted legacy balance ledger.
//!
//! This is the only snapshots module allowed to query the legacy
//! `balance_changes` table. It converts each asset's ordered
//! `balance_after` trajectory into sparse effective-dated snapshot rows,
//! beginning an asset's trusted history after its final continuity gap so
//! missing history is never served — and never represented as zero.
//! Reusing this already-built ledger avoids one archival RPC request per
//! historical event; authoritative RPC reads are reserved for current state.

use bigdecimal::{BigDecimal, Zero, num_traits::Signed};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::models::{PublicBalanceSnapshotRow, SnapshotAsset};
use super::repository::insert_snapshot_rows_if_absent;

const SEED_WRITE_BATCH: usize = 5_000;
const NOT_REGISTERED_COUNTERPARTY: &str = "NOT_REGISTERED";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SeedOutcome {
    pub rows_written: u64,
    pub assets_seeded: usize,
    pub assets_skipped: usize,
    pub gaps_detected: usize,
}

#[derive(Debug, sqlx::FromRow)]
struct LegacyBalanceRow {
    token_id: Option<String>,
    counterparty: String,
    block_height: i64,
    block_time: DateTime<Utc>,
    balance_before: BigDecimal,
    balance_after: BigDecimal,
}

/// One usable balance reading extracted from a legacy row.
#[derive(Debug, Clone)]
struct BalanceReading {
    block_height: i64,
    block_time: DateTime<Utc>,
    balance: BigDecimal,
    /// The row's claimed prior balance; `None` for marker rows whose
    /// `balance_before` is synthetic and must not drive gap detection.
    continuity_before: Option<BigDecimal>,
    /// A malformed row was dropped immediately before this reading, so the
    /// trajectory into it is unknown regardless of its own claim.
    after_dropped_row: bool,
}

pub struct LegacyHistorySeeder<'a> {
    pool: &'a PgPool,
    account_id: &'a str,
}

impl<'a> LegacyHistorySeeder<'a> {
    pub fn new(pool: &'a PgPool, account_id: &'a str) -> Self {
        Self { pool, account_id }
    }

    pub async fn seed(&self) -> Result<SeedOutcome, sqlx::Error> {
        let rows = self.load_ordered_history().await?;
        let mut outcome = SeedOutcome::default();
        let mut pending: Vec<PublicBalanceSnapshotRow> = Vec::new();

        for (asset, readings) in group_readings_by_asset(rows, &mut outcome) {
            let (trusted, gaps) = trusted_suffix(readings);
            outcome.gaps_detected += gaps;
            let sparse = collapse_identical_balances(trusted);
            if sparse.is_empty() {
                continue;
            }
            outcome.assets_seeded += 1;
            for reading in sparse {
                pending.push(PublicBalanceSnapshotRow {
                    dao_id: self.account_id.to_string(),
                    asset: asset.id.clone(),
                    block_height: reading.block_height,
                    block_time: reading.block_time,
                    balance: reading.balance,
                    usd_value: None,
                });
                if pending.len() >= SEED_WRITE_BATCH {
                    outcome.rows_written +=
                        insert_snapshot_rows_if_absent(self.pool, &pending).await?;
                    pending.clear();
                }
            }
        }
        if !pending.is_empty() {
            outcome.rows_written += insert_snapshot_rows_if_absent(self.pool, &pending).await?;
        }
        Ok(outcome)
    }

    async fn load_ordered_history(&self) -> Result<Vec<LegacyBalanceRow>, sqlx::Error> {
        sqlx::query_as(
            r#"
            SELECT
                token_id,
                counterparty,
                block_height,
                block_time,
                balance_before,
                balance_after
            FROM balance_changes
            WHERE account_id = $1
            ORDER BY token_id NULLS FIRST, block_height, id
            "#,
        )
        .bind(self.account_id)
        .fetch_all(self.pool)
        .await
    }
}

/// Map a legacy `balance_changes.token_id` onto the canonical snapshot asset
/// space. Unrecognizable ids are skipped rather than guessed.
fn canonical_seed_asset(token_id: &str) -> Option<SnapshotAsset> {
    let trimmed = token_id.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("near") {
        return Some(SnapshotAsset::near());
    }
    if let Some(pool_id) = trimmed.strip_prefix("staking:") {
        return is_valid_account(pool_id).then(|| SnapshotAsset::staking(pool_id));
    }
    if let Some(rest) = trimmed.strip_prefix("intents.near:") {
        return (!rest.is_empty()).then(|| SnapshotAsset::multi_token(trimmed));
    }
    if let Some(rest) = trimmed.strip_prefix("nep245:") {
        let (contract, token) = rest.split_once(':')?;
        return (is_valid_account(contract) && !token.is_empty())
            .then(|| SnapshotAsset::multi_token(trimmed));
    }
    if let Some((contract, token)) = trimmed.split_once(':') {
        return (is_valid_account(contract) && !token.is_empty())
            .then(|| SnapshotAsset::multi_token(format!("nep245:{trimmed}")));
    }
    is_valid_account(trimmed).then(|| SnapshotAsset::fungible(trimmed))
}

fn is_valid_account(account_id: &str) -> bool {
    account_id.parse::<near_api::AccountId>().is_ok()
}

/// Convert ordered legacy rows into per-asset reading sequences. Malformed
/// rows are dropped but poison the continuity into their successor;
/// `NOT_REGISTERED` markers become verified zero readings once the asset has
/// any prior trusted balance, and are ignored before it.
fn group_readings_by_asset(
    rows: Vec<LegacyBalanceRow>,
    outcome: &mut SeedOutcome,
) -> Vec<(SnapshotAsset, Vec<BalanceReading>)> {
    let mut grouped: Vec<(SnapshotAsset, Vec<BalanceReading>)> = Vec::new();
    let mut dropped_before_next: std::collections::BTreeMap<String, bool> =
        std::collections::BTreeMap::new();
    let mut skipped_assets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for row in rows {
        let token_id = row.token_id.as_deref().unwrap_or("near");
        let Some(asset) = canonical_seed_asset(token_id) else {
            if skipped_assets.insert(token_id.to_string()) {
                tracing::warn!(token_id, "skipping unrecognizable legacy asset id in seed");
            }
            continue;
        };

        let readings = match grouped.last_mut() {
            Some((last_asset, readings)) if *last_asset == asset => readings,
            _ => {
                grouped.push((asset.clone(), Vec::new()));
                &mut grouped.last_mut().expect("just pushed").1
            }
        };
        let after_dropped_row = dropped_before_next.remove(&asset.id).unwrap_or(false);

        if row.counterparty == NOT_REGISTERED_COUNTERPARTY {
            if readings.is_empty() {
                // A pre-registration marker precedes any trusted balance.
                continue;
            }
            readings.push(BalanceReading {
                block_height: row.block_height,
                block_time: row.block_time,
                balance: BigDecimal::zero(),
                continuity_before: None,
                after_dropped_row,
            });
            continue;
        }

        if row.balance_after.is_negative() {
            dropped_before_next.insert(asset.id.clone(), true);
            continue;
        }

        readings.push(BalanceReading {
            block_height: row.block_height,
            block_time: row.block_time,
            balance: row.balance_after,
            continuity_before: Some(row.balance_before),
            after_dropped_row,
        });
    }

    outcome.assets_skipped = skipped_assets.len();
    grouped
}

/// Trusted history begins after the final continuity gap: a reading whose
/// claimed prior balance disagrees with its predecessor's balance proves
/// events are missing in between, so everything before it is untrusted.
/// Returns the trusted suffix and the number of gaps found.
fn trusted_suffix(mut readings: Vec<BalanceReading>) -> (Vec<BalanceReading>, usize) {
    let mut trusted_from = 0usize;
    let mut gaps = 0usize;
    for index in 1..readings.len() {
        let reading = &readings[index];
        let previous = &readings[index - 1];
        // A same-block reading replaces its predecessor (canonical-id merges
        // can produce these); it is a rewrite, not a continuity break.
        let disagrees = reading.block_height != previous.block_height
            && reading
                .continuity_before
                .as_ref()
                .is_some_and(|before| *before != previous.balance);
        if reading.after_dropped_row || disagrees {
            gaps += 1;
            trusted_from = index;
        }
    }
    readings.drain(..trusted_from);
    (readings, gaps)
}

/// Consecutive identical balances collapse to the earliest reading; repeated
/// readings at one block keep the last (later legacy rows supersede).
fn collapse_identical_balances(readings: Vec<BalanceReading>) -> Vec<BalanceReading> {
    let mut sparse: Vec<BalanceReading> = Vec::new();
    for reading in readings {
        match sparse.last_mut() {
            Some(last) if last.block_height == reading.block_height => *last = reading,
            Some(last) if last.balance == reading.balance => {}
            _ => sparse.push(reading),
        }
    }
    sparse
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    #[test]
    fn seed_module_only_reads_the_legacy_table() {
        let source = include_str!("seed.rs").to_ascii_lowercase();
        let table = ["balance", "changes"].join("_");
        for forbidden in ["insert into", "update", "delete from"] {
            assert!(
                !source.contains(&format!("{forbidden} {table}")),
                "seed must never write to the legacy balance table"
            );
        }
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn seeds_sparse_trusted_rows_from_the_legacy_ledger(
        pool: sqlx::PgPool,
    ) -> sqlx::Result<()> {
        let account_id = "seed-e2e.sputnik-dao.near";
        // The fixture writes to the legacy table; assembled dynamically so the
        // read-only source guard above stays meaningful.
        let insert = format!(
            r#"
            INSERT INTO {} (
                account_id, block_height, block_timestamp, block_time,
                token_id, counterparty, amount, balance_before, balance_after
            )
            SELECT $1, height, height, to_timestamp(height),
                   $2, counterparty, 0, before_balance, after_balance
            FROM UNNEST($3::bigint[], $4::text[], $5::numeric[], $6::numeric[])
                AS fixture(height, counterparty, before_balance, after_balance)
            "#,
            ["balance", "changes"].join("_")
        );
        sqlx::query(&insert)
            .bind(account_id)
            .bind("wrap.near")
            .bind([10i64, 20, 30].as_slice())
            .bind(
                ["alice.near", "SNAPSHOT", "bob.near"]
                    .map(String::from)
                    .as_slice(),
            )
            .bind([BigDecimal::zero(), 5.into(), 5.into()].as_slice())
            .bind([BigDecimal::from(5), 5.into(), 9.into()].as_slice())
            .execute(&pool)
            .await?;

        let outcome = LegacyHistorySeeder::new(&pool, account_id).seed().await?;
        assert_eq!(outcome.assets_seeded, 1);
        assert_eq!(outcome.rows_written, 2);
        assert_eq!(outcome.gaps_detected, 0);

        let stored: Vec<(String, i64, BigDecimal)> = sqlx::query_as(
            r#"
            SELECT asset, block_height, balance
            FROM public_balance_snapshot
            WHERE dao_id = $1
            ORDER BY block_height
            "#,
        )
        .bind(account_id)
        .fetch_all(&pool)
        .await?;
        assert_eq!(
            stored,
            vec![
                ("wrap.near".to_string(), 10, BigDecimal::from(5)),
                ("wrap.near".to_string(), 30, BigDecimal::from(9)),
            ]
        );

        // Reseeding is idempotent: every coordinate already exists.
        let again = LegacyHistorySeeder::new(&pool, account_id).seed().await?;
        assert_eq!(again.rows_written, 0);
        Ok(())
    }

    fn row(
        token_id: Option<&str>,
        counterparty: &str,
        block_height: i64,
        before: &str,
        after: &str,
    ) -> LegacyBalanceRow {
        LegacyBalanceRow {
            token_id: token_id.map(str::to_string),
            counterparty: counterparty.to_string(),
            block_height,
            block_time: DateTime::from_timestamp(block_height, 0).unwrap(),
            balance_before: BigDecimal::from_str(before).unwrap(),
            balance_after: BigDecimal::from_str(after).unwrap(),
        }
    }

    type SeededAssets = Vec<(String, Vec<(i64, String)>)>;

    fn seeded(rows: Vec<LegacyBalanceRow>) -> (SeededAssets, SeedOutcome) {
        let mut outcome = SeedOutcome::default();
        let assets = group_readings_by_asset(rows, &mut outcome)
            .into_iter()
            .filter_map(|(asset, readings)| {
                let (trusted, gaps) = trusted_suffix(readings);
                outcome.gaps_detected += gaps;
                let sparse = collapse_identical_balances(trusted);
                (!sparse.is_empty()).then(|| {
                    (
                        asset.id,
                        sparse
                            .into_iter()
                            .map(|reading| (reading.block_height, reading.balance.to_string()))
                            .collect(),
                    )
                })
            })
            .collect();
        (assets, outcome)
    }

    #[test]
    fn canonicalizes_every_legacy_asset_id_shape() {
        assert_eq!(canonical_seed_asset("near"), Some(SnapshotAsset::near()));
        assert_eq!(canonical_seed_asset("NEAR"), Some(SnapshotAsset::near()));
        assert_eq!(
            canonical_seed_asset("wrap.near"),
            Some(SnapshotAsset::fungible("wrap.near"))
        );
        assert_eq!(
            canonical_seed_asset("staking:astro-stakers.poolv1.near"),
            Some(SnapshotAsset::staking("astro-stakers.poolv1.near"))
        );
        assert_eq!(
            canonical_seed_asset("intents.near:nep141:eth.omft.near"),
            Some(SnapshotAsset::multi_token(
                "intents.near:nep141:eth.omft.near"
            ))
        );
        assert_eq!(
            canonical_seed_asset("nep245:v2_1.omni.hot.tg:137_abc"),
            Some(SnapshotAsset::multi_token(
                "nep245:v2_1.omni.hot.tg:137_abc"
            ))
        );
        assert_eq!(
            canonical_seed_asset("v2_1.omni.hot.tg:137_abc"),
            Some(SnapshotAsset::multi_token(
                "nep245:v2_1.omni.hot.tg:137_abc"
            ))
        );
        assert_eq!(canonical_seed_asset("staking:not an account"), None);
        assert_eq!(canonical_seed_asset("not an account"), None);
    }

    #[test]
    fn collapses_identical_balances_and_dedups_blocks() {
        let (assets, _) = seeded(vec![
            row(Some("wrap.near"), "alice.near", 10, "0", "5"),
            row(Some("wrap.near"), "SNAPSHOT", 20, "5", "5"),
            row(Some("wrap.near"), "bob.near", 30, "5", "9"),
            row(Some("wrap.near"), "carol.near", 30, "5", "7"),
        ]);
        assert_eq!(
            assets,
            vec![(
                "wrap.near".to_string(),
                vec![(10, "5".to_string()), (30, "7".to_string())]
            )]
        );
    }

    #[test]
    fn trusted_history_begins_after_the_final_gap() {
        let (assets, outcome) = seeded(vec![
            row(Some("wrap.near"), "alice.near", 10, "0", "5"),
            // Gap: claims prior balance 7, predecessor recorded 5.
            row(Some("wrap.near"), "bob.near", 20, "7", "9"),
            row(Some("wrap.near"), "carol.near", 30, "9", "4"),
        ]);
        assert_eq!(
            assets,
            vec![(
                "wrap.near".to_string(),
                vec![(20, "9".to_string()), (30, "4".to_string())]
            )]
        );
        assert_eq!(outcome.gaps_detected, 1);
    }

    #[test]
    fn not_registered_becomes_zero_only_after_trusted_history() {
        let (assets, _) = seeded(vec![
            // Pre-registration marker: ignored entirely.
            row(Some("usdt.near"), "NOT_REGISTERED", 5, "0", "0"),
            row(Some("usdt.near"), "alice.near", 10, "0", "5"),
            row(Some("usdt.near"), "alice.near", 20, "5", "0"),
            // Post-withdrawal unregistration: a verified zero, not a gap.
            row(Some("usdt.near"), "NOT_REGISTERED", 30, "0", "0"),
            row(Some("other.near"), "NOT_REGISTERED", 8, "0", "0"),
        ]);
        assert_eq!(
            assets,
            vec![(
                "usdt.near".to_string(),
                vec![(10, "5".to_string()), (20, "0".to_string())]
            )]
        );
    }

    #[test]
    fn malformed_rows_poison_continuity_into_their_successor() {
        let (assets, outcome) = seeded(vec![
            row(Some("wrap.near"), "alice.near", 10, "0", "5"),
            row(Some("wrap.near"), "broken.near", 20, "5", "-1"),
            row(Some("wrap.near"), "bob.near", 30, "-1", "3"),
            row(Some("wrap.near"), "carol.near", 40, "3", "8"),
        ]);
        assert_eq!(
            assets,
            vec![(
                "wrap.near".to_string(),
                vec![(30, "3".to_string()), (40, "8".to_string())]
            )]
        );
        assert_eq!(outcome.gaps_detected, 1);
    }

    #[test]
    fn null_token_id_is_native_near() {
        let (assets, _) = seeded(vec![row(None, "alice.near", 10, "0", "5")]);
        assert_eq!(
            assets,
            vec![("near".to_string(), vec![(10, "5".to_string())])]
        );
    }
}
