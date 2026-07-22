use std::collections::BTreeMap;

use bigdecimal::BigDecimal;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SnapshotAssetKind {
    Near,
    FungibleToken,
    MultiToken,
    Staking,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SnapshotAsset {
    pub id: String,
    pub kind: SnapshotAssetKind,
}

impl SnapshotAsset {
    pub fn near() -> Self {
        Self {
            id: "near".to_string(),
            kind: SnapshotAssetKind::Near,
        }
    }

    pub fn fungible(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: SnapshotAssetKind::FungibleToken,
        }
    }

    pub fn multi_token(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: SnapshotAssetKind::MultiToken,
        }
    }

    pub fn staking(pool_id: impl AsRef<str>) -> Self {
        Self {
            id: format!("staking:{}", pool_id.as_ref()),
            kind: SnapshotAssetKind::Staking,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotCursor {
    pub account_id: String,
    pub snapshot_dirty_generation: i64,
    pub snapshot_applied_generation: i64,
    pub snapshot_recompute_from: Option<DateTime<Utc>>,
    pub snapshot_applied_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotBootstrapCandidate {
    pub account_id: String,
    pub multi_token_recompute_from: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnapshotBootstrapStats {
    pub cursors_seeded: u64,
    pub multi_token_reprojections: u64,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct PublicBalanceSnapshotRow {
    pub dao_id: String,
    pub asset: String,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub balance: BigDecimal,
    pub usd_value: Option<BigDecimal>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotChartRow {
    pub asset: String,
    pub bucket: DateTime<Utc>,
    pub block_height: i64,
    pub balance: BigDecimal,
    pub usd_value: Option<BigDecimal>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SilverSnapshotLeg {
    pub token_standard: String,
    pub token_id: String,
    pub direction: String,
    pub leg_kind: String,
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub amount_raw: BigDecimal,
    pub decimals: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HistoricalAssetRow {
    pub token_standard: String,
    pub token_id: String,
}

impl HistoricalAssetRow {
    pub fn into_asset(self) -> Result<SnapshotAsset, String> {
        match self.token_standard.as_str() {
            "native" => Ok(SnapshotAsset::near()),
            "nep141" => Ok(SnapshotAsset::fungible(self.token_id)),
            "nep245" => Ok(SnapshotAsset::multi_token(self.token_id)),
            other => Err(format!("unsupported token standard {other}")),
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BronzeSnapshotCoordinate {
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub contract_account_id: Option<String>,
    pub method_name: Option<String>,
}

impl SilverSnapshotLeg {
    pub fn asset(&self) -> Result<SnapshotAsset, String> {
        match self.token_standard.as_str() {
            "native" => Ok(SnapshotAsset::near()),
            "nep141" => Ok(SnapshotAsset::fungible(self.token_id.clone())),
            "nep245" => Ok(SnapshotAsset::multi_token(self.token_id.clone())),
            other => Err(format!("unsupported token standard {other}")),
        }
    }

    /// Silver records FT mint/burn as `internal`; those two kinds are the
    /// only internal movements that form a valid replay delta. MT directions
    /// are already sign-based and therefore use the normal branches.
    pub fn signed_amount_raw(&self) -> Result<BigDecimal, String> {
        match (
            self.token_standard.as_str(),
            self.direction.as_str(),
            self.leg_kind.as_str(),
        ) {
            ("nep141", "internal", "mint") => Ok(self.amount_raw.clone()),
            ("nep141", "internal", "burn") => Ok(-self.amount_raw.clone()),
            (_, "incoming", _) => Ok(self.amount_raw.clone()),
            (_, "outgoing", _) => Ok(-self.amount_raw.clone()),
            _ => Err(format!(
                "unsupported internal movement standard={} kind={}",
                self.token_standard, self.leg_kind
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventDelta {
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub delta_raw: BigDecimal,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssetEventLedger {
    pub decimals: i32,
    pub events: Vec<EventDelta>,
}

/// Group same-asset, same-block legs before applying them. The stored point is
/// the balance after every movement in that block has completed.
pub fn group_event_deltas(
    legs: impl IntoIterator<Item = SilverSnapshotLeg>,
) -> Result<BTreeMap<SnapshotAsset, AssetEventLedger>, String> {
    let mut grouped: BTreeMap<(SnapshotAsset, i64), (DateTime<Utc>, BigDecimal, i32)> =
        BTreeMap::new();

    for leg in legs {
        let asset = leg.asset()?;
        if asset.kind == SnapshotAssetKind::Near {
            // Native history is authoritative RPC-only. Silver's explicit
            // transfer subset is not sufficient for a native ledger.
            continue;
        }
        let signed = leg.signed_amount_raw()?;
        let entry = grouped
            .entry((asset, leg.block_height))
            .or_insert_with(|| (leg.block_time, BigDecimal::from(0), leg.decimals));
        if entry.2 != leg.decimals {
            return Err(format!(
                "asset decimals changed within block: {} != {}",
                entry.2, leg.decimals
            ));
        }
        entry.0 = entry.0.max(leg.block_time);
        entry.1 += signed;
    }

    let mut by_asset: BTreeMap<SnapshotAsset, AssetEventLedger> = BTreeMap::new();
    for ((asset, block_height), (block_time, delta_raw, decimals)) in grouped {
        let ledger = by_asset.entry(asset).or_insert_with(|| AssetEventLedger {
            decimals,
            events: Vec::new(),
        });
        if ledger.decimals != decimals {
            return Err(format!(
                "asset decimals changed across history: {} != {}",
                ledger.decimals, decimals
            ));
        }
        ledger.events.push(EventDelta {
            block_height,
            block_time,
            delta_raw,
        });
    }
    for ledger in by_asset.values_mut() {
        ledger
            .events
            .sort_by_key(|event| (event.block_height, event.block_time));
    }
    Ok(by_asset)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthoritativePoint {
    pub block_height: i64,
    pub block_time: DateTime<Utc>,
    pub balance: BigDecimal,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotCycleStats {
    pub accounts_seen: usize,
    pub accounts_applied: usize,
    pub accounts_skipped: usize,
    pub accounts_failed: usize,
    pub rows_written: u64,
    pub replay_segments_repaired: u64,
    pub usd_values_repaired: u64,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-22T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn leg(standard: &str, direction: &str, kind: &str, amount: &str) -> SilverSnapshotLeg {
        SilverSnapshotLeg {
            token_standard: standard.to_string(),
            token_id: "token.near".to_string(),
            direction: direction.to_string(),
            leg_kind: kind.to_string(),
            block_height: 10,
            block_time: at(),
            amount_raw: BigDecimal::from_str(amount).unwrap(),
            decimals: 0,
        }
    }

    #[test]
    fn restores_ft_mint_and_burn_signs_only() {
        assert_eq!(
            leg("nep141", "internal", "mint", "3")
                .signed_amount_raw()
                .unwrap(),
            BigDecimal::from(3)
        );
        assert_eq!(
            leg("nep141", "internal", "burn", "3")
                .signed_amount_raw()
                .unwrap(),
            BigDecimal::from(-3)
        );
        assert!(
            leg("nep245", "internal", "mint", "3")
                .signed_amount_raw()
                .is_err()
        );
    }

    #[test]
    fn groups_all_legs_at_block_into_one_delta() {
        let grouped = group_event_deltas([
            leg("nep141", "incoming", "transfer", "5"),
            leg("nep141", "outgoing", "transfer", "2"),
        ])
        .unwrap();
        let ledger = grouped.values().next().unwrap();
        assert_eq!(ledger.events.len(), 1);
        assert_eq!(ledger.events[0].delta_raw, BigDecimal::from(3));
    }
}
