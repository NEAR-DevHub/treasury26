//! NEP-641 caller-side authorization resolver.
//!
//! Implements the canonical caller-side algorithm from `nep-0641.md`
//! ("Caller-side resolution algorithm"), including the NEP-413 fallback for
//! regular NEAR accounts that don't implement `w_resolve_auth`.
//!
//! The dApp backend pins a finalized `block_id` once, then recursively resolves
//! the authorization graph against that single chain state. Each wallet contract
//! is the authority for its own account via the `w_resolve_auth` view function;
//! accounts without the method fall back to NEP-413 signature verification with
//! the purpose bound into the recipient as `"<PURPOSE>@<recipient>"`.

use crate::utils::jsonrpc::create_rpc_client;
use base64::Engine;
use near_api::NetworkConfig;
use near_jsonrpc_client::{JsonRpcClient, methods};
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::types::{BlockId, BlockReference, FunctionArgs};
use near_primitives::views::QueryRequest;
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;

/// Maximum recursion depth for the authorization graph walk. Off-chain
/// resolution is bounded by the caller; a malicious cyclic graph terminates
/// here rather than looping forever.
const MAX_RECURSION_DEPTH: usize = 8;

/// Account-not-found can transiently appear right after a relayer creates a
/// deterministic wallet-contract account (the FE's EIP-712 `resolveAuth`
/// state-inits the account on-chain): the view call may race ahead of chain
/// indexing. Retry with exponential backoff so the caller doesn't see a false
/// negative.
const ACCOUNT_NOT_FOUND_RETRY_DELAYS_MS: [u64; 5] = [1000, 2000, 4000, 8000, 16000];

/// Outcome of resolving an authorization (sub-)graph.
enum ResolveOutcome {
    /// Authorization is valid; carries the unwrapped payload.
    Resolved(String),
    /// Authorization is invalid; carries a human-readable reason.
    Invalid(String),
    /// The account does not exist yet (drives the retry loop).
    UnknownAccount(String),
}

/// On-chain `AuthorizationResolution` wire format (internally-tagged on
/// `status`, SCREAMING_SNAKE_CASE variants).
#[derive(Deserialize)]
#[serde(tag = "status")]
enum AuthorizationResolution {
    #[serde(rename = "RESOLVED")]
    Resolved { payload: String },
    #[serde(rename = "PENDING")]
    Pending {
        payload: String,
        #[serde(default)]
        pending_authorizations: Vec<PendingAuthorization>,
    },
    #[serde(rename = "INVALID")]
    Invalid {
        #[serde(default)]
        error_kind: Option<String>,
        #[serde(default)]
        error_message: Option<String>,
    },
}

#[derive(Deserialize)]
struct PendingAuthorization {
    account_id: String,
    purpose: String,
    authorization: String,
}

/// NEP-413 `SignedMessage` as produced by the wallet adaptor's `resolveAuth`
/// fallback (a JSON-stringified blob).
#[derive(Deserialize)]
struct Nep413SignedMessage {
    #[serde(rename = "publicKey")]
    public_key: String,
    signature: String,
    message: String,
    recipient: String,
    /// base64-encoded 32 bytes
    nonce: String,
    #[serde(rename = "callbackUrl", default)]
    callback_url: Option<String>,
}

/// Verify a NEP-641 authorization for `account_id` and return the resolved
/// payload on success.
///
/// `recipient` is the bare recipient (e.g. the dApp identifier); the purpose is
/// bound into it as `"<PURPOSE>@<recipient>"` for the NEP-413 fallback path, and
/// passed as-is to `w_resolve_auth` for the contract path.
pub async fn verify_resolve_auth(
    network: &NetworkConfig,
    account_id: &str,
    purpose: &str,
    recipient: &str,
    authorization: &str,
) -> Result<String, String> {
    let client = create_rpc_client(network).map_err(|e| e.to_string())?;

    let mut last_invalid: Option<String> = None;

    // Initial attempt + retries with backoff when the account doesn't exist yet.
    for attempt in 0..=ACCOUNT_NOT_FOUND_RETRY_DELAYS_MS.len() {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                ACCOUNT_NOT_FOUND_RETRY_DELAYS_MS[attempt - 1],
            ))
            .await;
        }

        // Re-pin the block each attempt so access-key lookups in the NEP-413
        // fallback see the latest chain state once the account materializes.
        let block_height = fetch_final_block_height(&client).await?;

        let outcome = resolve(
            &client,
            account_id.to_string(),
            purpose.to_string(),
            recipient.to_string(),
            authorization.to_string(),
            block_height,
            0,
        )
        .await;

        match outcome {
            ResolveOutcome::Resolved(payload) => return Ok(payload),
            ResolveOutcome::Invalid(msg) => return Err(msg),
            ResolveOutcome::UnknownAccount(msg) => last_invalid = Some(msg),
        }
    }

    Err(last_invalid.unwrap_or_else(|| "account does not exist".to_string()))
}

async fn fetch_final_block_height(client: &JsonRpcClient) -> Result<u64, String> {
    let block = client
        .call(methods::block::RpcBlockRequest {
            block_reference: BlockReference::Finality(near_primitives::types::Finality::Final),
        })
        .await
        .map_err(|e| format!("failed to fetch finalized block: {e}"))?;
    Ok(block.header.height)
}

/// Recursively resolve an authorization sub-graph at the pinned `block_height`.
///
/// Args are owned (not borrowed) so the boxed future only ties its lifetime to
/// `client`; recursive calls pass freshly-cloned sub-authorization values.
fn resolve<'a>(
    client: &'a JsonRpcClient,
    account_id: String,
    purpose: String,
    recipient: String,
    authorization: String,
    block_height: u64,
    depth: usize,
) -> Pin<Box<dyn Future<Output = ResolveOutcome> + Send + 'a>> {
    Box::pin(async move {
        if depth > MAX_RECURSION_DEPTH {
            return ResolveOutcome::Invalid("recursion limit exceeded".to_string());
        }

        let view_bytes = match view_w_resolve_auth(
            client,
            &account_id,
            &purpose,
            &recipient,
            &authorization,
            block_height,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(err) => {
                // NEP-641 §"NEP-413 fallback": fall back ONLY when the method
                // genuinely does not exist (or no contract is deployed).
                if is_method_not_found(&err) {
                    return nep413_fallback(
                        client,
                        &account_id,
                        &purpose,
                        &recipient,
                        &authorization,
                        block_height,
                    )
                    .await;
                }
                if is_unknown_account(&err) {
                    return ResolveOutcome::UnknownAccount(err);
                }
                return ResolveOutcome::Invalid(err);
            }
        };

        let parsed: AuthorizationResolution = match serde_json::from_slice(&view_bytes) {
            Ok(parsed) => parsed,
            Err(_) => {
                return ResolveOutcome::Invalid("w_resolve_auth returned non-JSON".to_string());
            }
        };

        match parsed {
            AuthorizationResolution::Resolved { payload } => ResolveOutcome::Resolved(payload),
            // NEP-641 §"Authoritative contract method (no downgrade)": once
            // w_resolve_auth returns INVALID we MUST NOT fall back to NEP-413.
            AuthorizationResolution::Invalid {
                error_kind,
                error_message,
            } => ResolveOutcome::Invalid(
                error_message
                    .or(error_kind)
                    .unwrap_or_else(|| "INVALID".to_string()),
            ),
            AuthorizationResolution::Pending {
                payload,
                pending_authorizations,
            } => {
                if pending_authorizations.is_empty() {
                    return ResolveOutcome::Invalid(
                        "contract returned PENDING with no dependencies".to_string(),
                    );
                }
                for sub in &pending_authorizations {
                    let sub_outcome = resolve(
                        client,
                        sub.account_id.clone(),
                        sub.purpose.clone(),
                        recipient.clone(),
                        sub.authorization.clone(),
                        block_height,
                        depth + 1,
                    )
                    .await;
                    match sub_outcome {
                        ResolveOutcome::Resolved(sub_payload) => {
                            // Load-bearing invariant: payload identical across
                            // the whole graph.
                            if sub_payload != payload {
                                return ResolveOutcome::Invalid(
                                    "payload mismatch in sub-resolution".to_string(),
                                );
                            }
                        }
                        other => return other,
                    }
                }
                ResolveOutcome::Resolved(payload)
            }
        }
    })
}

/// Call `w_resolve_auth` on `account_id` at the pinned block. Returns the raw
/// return bytes, or an `Err(String)` whose message is the debug representation
/// of the RPC error (so callers can probe for method-not-found / unknown-account).
async fn view_w_resolve_auth(
    client: &JsonRpcClient,
    account_id: &str,
    purpose: &str,
    recipient: &str,
    authorization: &str,
    block_height: u64,
) -> Result<Vec<u8>, String> {
    let account: near_primitives::types::AccountId = account_id
        .parse()
        .map_err(|e| format!("invalid account id \"{account_id}\": {e}"))?;

    let args = serde_json::json!({
        "purpose": purpose,
        "recipient": recipient,
        "authorization": authorization,
    });
    let args_bytes = serde_json::to_vec(&args).map_err(|e| e.to_string())?;

    let request = methods::query::RpcQueryRequest {
        block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
        request: QueryRequest::CallFunction {
            account_id: account,
            method_name: "w_resolve_auth".to_string(),
            args: FunctionArgs::from(args_bytes),
        },
    };

    let response = client
        .call(request)
        .await
        // Debug repr surfaces the nested handler error (MethodResolveError,
        // UnknownAccount, …) that the Display impl hides behind "Server error".
        .map_err(|e| format!("{e:?}"))?;

    match response.kind {
        QueryResponseKind::CallResult(result) => Ok(result.result),
        _ => Err("unexpected query response kind for call_function".to_string()),
    }
}

/// NEP-641 §"NEP-413 fallback": verify the authorization as a NEP-413
/// `SignedMessage` against the account's access keys at the pinned block.
async fn nep413_fallback(
    client: &JsonRpcClient,
    account_id: &str,
    purpose: &str,
    recipient: &str,
    authorization: &str,
    block_height: u64,
) -> ResolveOutcome {
    let msg: Nep413SignedMessage = match serde_json::from_str(authorization) {
        Ok(msg) => msg,
        Err(_) => {
            return ResolveOutcome::Invalid("authorization is not valid NEP-413 JSON".to_string());
        }
    };

    // Purpose binding: the signed recipient must be "<PURPOSE>@<recipient>".
    let expected_recipient = format!("{purpose}@{recipient}");
    if msg.recipient != expected_recipient {
        return ResolveOutcome::Invalid(format!(
            "recipient mismatch: expected \"{expected_recipient}\""
        ));
    }

    let nonce_bytes = match base64::engine::general_purpose::STANDARD.decode(&msg.nonce) {
        Ok(bytes) => bytes,
        Err(_) => return ResolveOutcome::Invalid("nonce is not valid base64".to_string()),
    };
    let nonce: [u8; 32] = match nonce_bytes.as_slice().try_into() {
        Ok(nonce) => nonce,
        Err(_) => return ResolveOutcome::Invalid("nep-413 nonce must be 32 bytes".to_string()),
    };

    let public_key: near_crypto::PublicKey = match msg.public_key.parse() {
        Ok(pk) => pk,
        Err(e) => return ResolveOutcome::Invalid(format!("invalid public key: {e}")),
    };

    // Verify the public key is registered on `account_id` at the pinned block.
    let account: near_primitives::types::AccountId = match account_id.parse() {
        Ok(account) => account,
        Err(e) => return ResolveOutcome::Invalid(format!("invalid account id: {e}")),
    };
    let keys = match client
        .call(methods::query::RpcQueryRequest {
            block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
            request: QueryRequest::ViewAccessKeyList {
                account_id: account,
            },
        })
        .await
    {
        Ok(response) => match response.kind {
            QueryResponseKind::AccessKeyList(list) => list.keys,
            _ => {
                return ResolveOutcome::Invalid(
                    "unexpected query response kind for access key list".to_string(),
                );
            }
        },
        Err(e) => {
            let err = format!("{e:?}");
            if is_unknown_account(&err) {
                return ResolveOutcome::UnknownAccount(err);
            }
            return ResolveOutcome::Invalid(format!("failed to fetch access keys: {err}"));
        }
    };
    if !keys.iter().any(|k| k.public_key == public_key) {
        return ResolveOutcome::Invalid(
            "public key not registered on account at pinned block".to_string(),
        );
    }

    // Recompute the NEP-413 borsh hash (tag 2^31 + 413) over the signed payload.
    let hash = match (near_api::signer::NEP413Payload {
        message: msg.message.clone(),
        nonce,
        recipient: msg.recipient.clone(),
        callback_url: msg.callback_url.clone(),
    })
    .compute_hash()
    {
        Ok(hash) => hash,
        Err(e) => return ResolveOutcome::Invalid(format!("failed to compute NEP-413 hash: {e}")),
    };

    let signature = match parse_ed25519_signature(&msg.signature) {
        Ok(signature) => signature,
        Err(e) => return ResolveOutcome::Invalid(e),
    };

    if signature.verify(hash.0.as_ref(), &public_key) {
        ResolveOutcome::Resolved(msg.message)
    } else {
        ResolveOutcome::Invalid("bad signature".to_string())
    }
}

/// Accept either raw base64 (NEP-413 `signMessage` canonical output) or
/// `"ed25519:<base58>"`.
fn parse_ed25519_signature(s: &str) -> Result<near_crypto::Signature, String> {
    let raw = if let Some(b58) = s.strip_prefix("ed25519:") {
        bs58::decode(b58)
            .into_vec()
            .map_err(|e| format!("invalid base58 signature: {e}"))?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(|e| format!("invalid base64 signature: {e}"))?
    };
    if raw.len() != 64 {
        return Err(format!(
            "ed25519 signature must be 64 bytes, got {}",
            raw.len()
        ));
    }
    near_crypto::Signature::from_parts(near_crypto::KeyType::ED25519, &raw)
        .map_err(|e| format!("invalid signature: {e}"))
}

/// NEP-641 §"NEP-413 fallback": detect "the method does not exist" / "no
/// contract deployed" so we fall back to NEP-413 — but not on other errors,
/// which could mask real bugs in a deployed wallet contract.
fn is_method_not_found(probe: &str) -> bool {
    let p = probe.to_lowercase();
    // contract has no such method
    p.contains("methodresolveerror")
        || p.contains("method not found")
        || p.contains("methodnotfound")
        || p.contains("methodnamemismatch")
        || p.contains("methodutf8error")
        // no contract code is deployed on the account
        || p.contains("codedoesnotexist")
        || p.contains("nocontractcode")
        || p.contains("contractcodenotfound")
        || p.contains("no contract code")
}

/// Detect the "account does not exist (yet)" RPC error so the caller can retry.
fn is_unknown_account(probe: &str) -> bool {
    let p = probe.to_lowercase();
    p.contains("unknown_account")
        || p.contains("unknownaccount")
        || p.contains("does not exist while viewing")
        || p.contains("account_does_not_exist")
}
