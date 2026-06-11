//! Typed, lenient views over a Sputnik DAO proposal `kind`.
//!
//! A `kind` is externally tagged (`{"Transfer": {...}}` / `{"FunctionCall": {...}}`)
//! and may use shapes we don't model (governance kinds) or sentinels we can't parse
//! (native NEAR `token_id: ""`). Parsing is therefore lenient: an unknown or invalid
//! kind yields an empty [`ProposalKind`], never an error — so a proposal is never
//! rejected for carrying a kind we don't introspect, and native-NEAR transfers
//! simply imply no NEP-141 registration.
//!
//! Only the parts the relay introspects are modelled: `Transfer` (NEP-141
//! registration) and `FunctionCall` (registration + the `v1.signer` confidential
//! payload hash). Everything else leaves both fields `None`.

use near_api::AccountId;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ProposalKind {
    #[serde(rename = "Transfer")]
    pub(crate) transfer: Option<TransferKind>,
    #[serde(rename = "FunctionCall")]
    pub(crate) function_call: Option<FunctionCallKind>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TransferKind {
    // Native NEAR uses the sentinel token_id "", which is not a valid AccountId;
    // such transfers fail to deserialize and yield no registration (correct —
    // native NEAR needs none).
    pub(crate) token_id: AccountId,
    pub(crate) receiver_id: AccountId,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FunctionCallKind {
    pub(crate) receiver_id: AccountId,
    #[serde(default)]
    pub(crate) actions: Vec<ProposalFunctionCall>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProposalFunctionCall {
    pub(crate) method_name: String,
    /// Base64-encoded JSON args.
    #[serde(default)]
    pub(crate) args: String,
}

impl ProposalKind {
    /// Parse a raw `kind` value leniently: unknown or invalid kinds yield an empty
    /// `ProposalKind` rather than an error.
    pub(crate) fn from_value(kind: &Value) -> Self {
        serde_json::from_value(kind.clone()).unwrap_or_default()
    }
}
