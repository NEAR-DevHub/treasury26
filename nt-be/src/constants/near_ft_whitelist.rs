/// Custom whitelist of NEAR FT contracts that should always appear in treasury
/// assets when the account holds a positive balance — even if they are not listed
/// on Ref Finance or other aggregators.
///
/// These are native NEAR FTs so NearBlocks can resolve their
/// metadata and we can display them in the dashboard.
pub const NEAR_FT_WHITELIST: &[&str] = &["nexus.nexusdev.near"];

/// Returns true if the given contract ID is in our custom NEAR FT whitelist.
pub fn is_whitelisted_near_ft(contract_id: &str) -> bool {
    NEAR_FT_WHITELIST
        .iter()
        .any(|&id| id.eq_ignore_ascii_case(contract_id))
}
