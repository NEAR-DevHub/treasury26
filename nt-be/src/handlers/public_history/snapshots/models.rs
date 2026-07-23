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

    /// Parse a stored `public_balance_snapshot.asset` id back into a typed
    /// asset. Stored ids are canonical by construction, so every stored
    /// value round-trips.
    pub fn from_stored_id(id: &str) -> Self {
        if id == "near" {
            return Self::near();
        }
        if let Some(pool) = id.strip_prefix("staking:") {
            return Self::staking(pool);
        }
        if id.contains(':') {
            return Self::multi_token(id);
        }
        Self::fungible(id)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotCursor {
    pub account_id: String,
    pub snapshot_dirty_generation: i64,
    pub snapshot_applied_generation: i64,
    pub snapshot_recompute_from: Option<DateTime<Utc>>,
    pub snapshot_applied_at: Option<DateTime<Utc>>,
    pub snapshot_seeded_at: Option<DateTime<Utc>>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotUsdScanCursor {
    pub block_time: DateTime<Utc>,
    pub dao_id: String,
    pub asset: String,
    pub block_height: i64,
}

impl From<&PublicBalanceSnapshotRow> for SnapshotUsdScanCursor {
    fn from(row: &PublicBalanceSnapshotRow) -> Self {
        Self {
            block_time: row.block_time,
            dao_id: row.dao_id.clone(),
            asset: row.asset.clone(),
            block_height: row.block_height,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SnapshotChartRow {
    pub asset: String,
    pub bucket: DateTime<Utc>,
    pub balance: BigDecimal,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotCycleStats {
    pub accounts_seen: usize,
    pub accounts_applied: usize,
    pub accounts_skipped: usize,
    pub accounts_failed: usize,
    pub rows_written: u64,
    pub usd_values_repaired: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_asset_ids_round_trip_to_typed_assets() {
        assert_eq!(SnapshotAsset::from_stored_id("near"), SnapshotAsset::near());
        assert_eq!(
            SnapshotAsset::from_stored_id("staking:astro-stakers.poolv1.near"),
            SnapshotAsset::staking("astro-stakers.poolv1.near")
        );
        assert_eq!(
            SnapshotAsset::from_stored_id("wrap.near"),
            SnapshotAsset::fungible("wrap.near")
        );
        assert_eq!(
            SnapshotAsset::from_stored_id("intents.near:nep141:eth.omft.near"),
            SnapshotAsset::multi_token("intents.near:nep141:eth.omft.near")
        );
        assert_eq!(
            SnapshotAsset::from_stored_id("nep245:v2_1.omni.hot.tg:137_abc"),
            SnapshotAsset::multi_token("nep245:v2_1.omni.hot.tg:137_abc")
        );
    }
}
