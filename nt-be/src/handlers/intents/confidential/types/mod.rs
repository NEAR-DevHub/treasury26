//! Shared types for the confidential history pipeline.

pub mod account_id;
pub mod enums;
pub mod payloads;

pub use account_id::{
    accounts_equal, as_near_account, bare_account, is_near_account, parse_bare_account,
    ParseAccountIdError,
};
pub use enums::{ConfidentialTxType, DepositType, HistoryStatus, RecipientAddressType};
pub use payloads::{
    normalize_quote_metadata_accounts, ConfidentialQuoteMetadata, HistoryApiEvent, HistoryApiItem,
    HistoryApiPage,
};
