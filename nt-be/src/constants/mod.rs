use near_account_id::AccountIdRef;

pub mod intents_tokens;

pub const REF_FINANCE_CONTRACT_ID: &AccountIdRef =
    AccountIdRef::new_or_panic("v2.ref-finance.near");

pub const INTENTS_CONTRACT_ID: &AccountIdRef = AccountIdRef::new_or_panic("intents.near");

pub const NEAR_ICON: &str = "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png";
pub const WRAP_NEAR_ICON: &str = "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png";
pub const BLOCKS_PER_HOUR: u64 = 300; // Approximate blocks per hour on NEAR

pub const BATCH_PAYMENT_ACCOUNT_ID: &AccountIdRef = AccountIdRef::new_or_panic("bulkpayment.near");
pub const TREASURY_FACTORY_CONTRACT_ID: &AccountIdRef =
    AccountIdRef::new_or_panic("sputnik-dao.near");
