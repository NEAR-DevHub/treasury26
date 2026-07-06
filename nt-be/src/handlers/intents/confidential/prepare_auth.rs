//! Prepare a confidential auth proposal for a DAO.
//!
//! Builds the NEP-413 auth message, computes the hash, and returns the
//! v1.signer proposal args. Also stores the auth payload so the relay
//! can auto-authenticate after the proposal is approved.

use axum::http::StatusCode;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::AppState;
use crate::constants::{INTENTS_CONTRACT_ID, V1_SIGNER_CONTRACT_ID};
const V1_SIGNER_GAS: &str = "250000000000000";

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAuthRequest {
    /// The DAO account ID
    pub dao_id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAuthResponse {
    /// The proposal to submit to the DAO (pass directly to add_proposal)
    pub proposal: serde_json::Value,
    /// The NEP-413 payload for later use in authenticate call
    pub auth_payload: AuthPayload,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthPayload {
    pub message: String,
    pub nonce: String,
    pub recipient: String,
}

/// Fetch the current salt from the intents.near contract.
#[tracing::instrument(level = "debug", skip_all, fields(step = "salt_fetch"))]
pub(crate) async fn fetch_salt(state: &Arc<AppState>) -> Result<[u8; 4], String> {
    let result = near_api::Contract(INTENTS_CONTRACT_ID.into())
        .call_function("current_salt", ())
        .read_only::<String>()
        .fetch_from(&state.network)
        .await
        .map_err(|e| format!("Failed to fetch salt from intents.near: {}", e))?;

    let hex_str = result.data.trim_matches('"');
    let salt_bytes = hex::decode(hex_str).map_err(|e| format!("Invalid salt hex: {}", e))?;

    salt_bytes
        .try_into()
        .map_err(|_| "Salt not 4 bytes".to_string())
}

/// Build a 32-byte nonce matching the 1Click API expected format.
pub(crate) fn build_nonce(salt: &[u8; 4], deadline: &chrono::DateTime<chrono::Utc>) -> [u8; 32] {
    let deadline_ns = (deadline.timestamp_millis() as u64) * 1_000_000;
    let now_ns = (chrono::Utc::now().timestamp_millis() as u64) * 1_000_000;
    let random_tail: [u8; 7] = rand::random();
    let mut nonce = [0u8; 32];
    nonce[0..4].copy_from_slice(&[0x56, 0x28, 0xF6, 0xC6]); // magic prefix
    nonce[4] = 0; // version
    nonce[5..9].copy_from_slice(salt);
    nonce[9..17].copy_from_slice(&deadline_ns.to_le_bytes());
    nonce[17..25].copy_from_slice(&now_ns.to_le_bytes());
    nonce[25..32].copy_from_slice(&random_tail);
    nonce
}

/// Build the auth proposal JSON and NEP-413 auth payload.
///
/// `signer_id` is the account 1Click will issue the JWT for (recorded in the
/// NEP-413 message). `signing_path` is the v1.signer derivation path used to
/// produce the signature — together with the proposal's predecessor
/// (`predecessor_account_id`, i.e. the DAO submitting the proposal) it
/// determines which MPC key signs.
///
/// For DAO self-auth: `signer_id == signing_path == dao_id`.
/// For bulk-payment-subaccount auth: `signer_id == sub`, `signing_path == ""`
/// — the DAO's MPC key still signs because `v1.signer` derives from the
/// proposal predecessor (DAO) plus path, and the intents `bootstrap()` flow
/// registers the DAO-derived pubkey for the subaccount on intents.near.
///
/// Returns `(proposal, auth_payload_json)` — the proposal is ready to pass to
/// `add_proposal`, and the auth payload is used later when authenticating with
/// the 1Click API.
#[tracing::instrument(level = "info", skip_all, fields(signer_id = %signer_id))]
pub(crate) async fn build_auth_proposal_with_signer(
    state: &Arc<AppState>,
    signer_id: &str,
    signing_path: &str,
    description: &str,
) -> Result<(serde_json::Value, serde_json::Value), (StatusCode, String)> {
    let expires_days = state.env_vars.confidential_auth_expires_days;
    let deadline = chrono::Utc::now() + chrono::Duration::days(expires_days);
    let deadline_str = deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let expires_in = expires_days * 24 * 3600;

    let auth_message = json!({
        "deadline": deadline_str,
        "intents": [],
        "signer_id": signer_id,
        "external_app_data": {
            "configs": [{
                "type": "auth",
                "expires_in": expires_in,
            }]
        }
    })
    .to_string();

    let salt = fetch_salt(state).await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to fetch salt: {}", e),
        )
    })?;
    let nonce = build_nonce(&salt, &deadline);
    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(nonce);

    let nep413_payload = near_api::signer::NEP413Payload {
        message: auth_message.clone(),
        nonce,
        recipient: INTENTS_CONTRACT_ID.to_string(),
        callback_url: None,
    };
    let hash = nep413_payload.compute_hash().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to compute NEP-413 hash: {}", e),
        )
    })?;
    let hash_hex = hex::encode(hash.0);

    let sign_args = json!({
        "request": {
            "path": signing_path,
            "payload_v2": { "Eddsa": hash_hex },
            "domain_id": 1,
        }
    });
    let sign_args_b64 = base64::engine::general_purpose::STANDARD.encode(sign_args.to_string());

    let proposal = json!({
        "proposal": {
            "description": description,
            "kind": {
                "FunctionCall": {
                        "receiver_id": V1_SIGNER_CONTRACT_ID,
                        "actions": [{
                        "method_name": "sign",
                        "args": sign_args_b64,
                        "deposit": "1",
                        "gas": V1_SIGNER_GAS,
                    }]
                }
            }
        }
    });

    let auth_payload = json!({
        "message": auth_message,
        "nonce": nonce_b64,
        "recipient": INTENTS_CONTRACT_ID.to_string(),
    });

    Ok((proposal, auth_payload))
}

/// Thin wrapper: build a DAO-self-auth proposal (signer = path = dao_id).
pub(crate) async fn build_auth_proposal(
    state: &Arc<AppState>,
    dao_id: &str,
) -> Result<(serde_json::Value, serde_json::Value), (StatusCode, String)> {
    build_auth_proposal_with_signer(
        state,
        dao_id,
        dao_id,
        "Authenticate DAO for confidential intents",
    )
    .await
}

/// Thin wrapper: build an auth proposal for the DAO's bulk-payment subaccount.
/// DAO signs as proposal predecessor (path = "") while the JWT is issued for the sub.
pub(crate) async fn build_bulk_payment_auth_proposal(
    state: &Arc<AppState>,
    bulk_sub_id: &str,
) -> Result<(serde_json::Value, serde_json::Value), (StatusCode, String)> {
    build_auth_proposal_with_signer(
        state,
        bulk_sub_id,
        "",
        "Authenticate bulk-payment subaccount for confidential intents",
    )
    .await
}
