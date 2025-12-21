use near_account_id::AccountIdRef;

pub mod intents_tokens;

pub const REF_FINANCE_CONTRACT_ID: &AccountIdRef =
    AccountIdRef::new_or_panic("v2.ref-finance.near");

pub const NEAR_ICON: &str = "https://img.rhea.finance/images/NEARIcon.png";
pub const WRAP_NEAR_ICON: &str = "https://img.rhea.finance/images/w-NEAR-no-border.png";
pub const BLOCKS_PER_HOUR: u64 = 300; // Approximate blocks per hour on NEAR
