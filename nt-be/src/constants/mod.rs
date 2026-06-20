use near_account_id::AccountIdRef;
use near_api::NearToken;

pub mod intents_chains;
pub mod intents_tokens;
pub mod near_ft_whitelist;

pub const REF_FINANCE_CONTRACT_ID: &AccountIdRef =
    AccountIdRef::new_or_panic("v2.ref-finance.near");

pub const INTENTS_CONTRACT_ID: &AccountIdRef = AccountIdRef::new_or_panic("intents.near");
pub const V1_SIGNER_CONTRACT_ID: &AccountIdRef = AccountIdRef::new_or_panic("v1.signer");
pub const LOCKUP_CONTRACT_ID: &AccountIdRef = AccountIdRef::new_or_panic("lockup.near");

pub const NEAR_ICON: &str = "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png";
pub const WRAP_NEAR_ICON: &str = "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png";
pub const NEAR_DECIMALS: u8 = 24;
pub const BLOCKS_PER_HOUR: u64 = 300; // Approximate blocks per hour on NEAR

pub const TREASURY_FACTORY_CONTRACT_ID: &AccountIdRef =
    AccountIdRef::new_or_panic("sputnik-dao.near");

/// Minimum liquid NEAR at which Telegram ops alerting should trigger.
pub const ALERT_LOW_BALANCE_THRESHOLD: NearToken = NearToken::from_near(5);
