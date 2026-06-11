//! Request/response types and the shared error shape for the relay endpoint.

use axum::{Json, http::StatusCode};
use near_api::{
    AccountId,
    types::json::{Base64VecU8, U128},
};
use serde::{Deserialize, Serialize};

/// Error returned by relay handlers: an HTTP status plus a JSON body.
pub type RelayError = (StatusCode, Json<RelayResponse>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub treasury_id: AccountId,
    /// Estimated bytes of DAO-contract storage a new `add_proposal` occupies. The
    /// relayer tops up the DAO's balance to cover it. Unrelated to NEP-141
    /// `storage_deposit` registrations.
    pub storage_bytes: U128,
    /// Base64-encoded borsh-serialized SignedDelegateAction.
    pub signed_delegate_action: Base64VecU8,
    /// Optional proposal type hint for metrics. Only set on the actual proposal call,
    /// NOT on helper calls like storage_deposit.
    /// "swap" → swap_proposals, "payment" → payment_proposals, "vote" → votes_casted,
    /// "confidential_transfer" and others → other_proposals_submitted.
    /// Absent/null → no metric recorded.
    #[serde(default)]
    pub proposal_type: Option<String>,
    /// True when a payment proposal recipient was selected from address book.
    /// Only set on the actual proposal call.
    #[serde(default)]
    pub address_book_payment: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Build an error response from a status and message.
pub fn error_response(status: StatusCode, msg: impl Into<String>) -> RelayError {
    (
        status,
        Json(RelayResponse {
            success: false,
            error: Some(msg.into()),
        }),
    )
}

/// The success body (`{ "success": true }`).
pub fn success_response() -> Json<RelayResponse> {
    Json(RelayResponse {
        success: true,
        error: None,
    })
}
