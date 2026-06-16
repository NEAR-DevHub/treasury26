//! Shared types for the confidential history pipeline.

pub mod account_id;
pub mod enums;
pub mod payloads;

pub use account_id::{
    ParseAccountIdError, accounts_equal, as_near_account, bare_account, is_near_account,
    parse_bare_account,
};
pub use enums::{
    ConfidentialDepositCorrectionSource, ConfidentialTxType, DepositType, HistoryStatus,
    RecipientAddressType,
};
pub use payloads::{
    ConfidentialQuoteMetadata, HistoryApiEvent, HistoryApiItem, HistoryApiPage,
    normalize_quote_metadata_accounts,
};
