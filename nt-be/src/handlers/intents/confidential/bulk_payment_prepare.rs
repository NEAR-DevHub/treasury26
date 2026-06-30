//! Prepare a confidential bulk-payment.
//!
//! Pipeline:
//! 1. Build N "recipient" intents (sub.bulk-payment.near → real recipient).
//!    Each gets its own 1Click quote + generate-intent + persisted row in
//!    `confidential_intents` with `intent_type = 'bulk_recipient'`.
//! 2. Build 1 "header" intent (DAO → sub.bulk-payment.near). Sum amount,
//!    same token, intra-`intents.near` mt_transfer. Persisted as a normal
//!    `'shield'` row so the existing single-confidential auto-submit path
//!    posts it once the DAO signs the proposal.
//! 3. Insert one row in `confidential_bulk_payments` linking the header
//!    payload hash to the N recipient hashes.
//!
//! Returns the header hash + recipient hashes so the FE can:
//!   - put the recipient hashes in the proposal description CSV
//!   - put the header hash inside the v1.signer FunctionCall args.

use axum::{Json, extract::State, http::StatusCode};
use chrono::Duration;
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

use crate::handlers::subscription::plans::get_account_plan_info;
use crate::handlers::treasury::confidential_setup::derive_bulk_subaccount_id;
use crate::{AppState, auth::AuthUser};

const MAX_RECIPIENTS_PER_BULK_PAYMENT: usize = 25;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkPaymentPrepareRequest {
    /// DAO account id ("<prefix>.sputnik-dao.near").
    pub dao_id: String,
    /// Origin asset (Intents asset id, e.g. "nep141:wrap.near").
    /// Confidential bulk only supports Intents tokens.
    pub origin_asset: String,
    /// FE picked the near.com (intra-Intents) row in the network selector.
    /// When true, recipients are NEAR accounts inside intents.near and
    /// `destination_asset` is ignored (origin is reused).
    #[serde(default)]
    pub to_near_com: bool,
    /// Cross-chain destination asset (Intents asset id for the picked bridge
    /// network), shared by all recipients. Required when `to_near_com` is false.
    pub destination_asset: Option<String>,
    /// Token decimals — needed to format amounts when displaying back.
    pub decimals: u8,
    /// Per-recipient payment list. Amounts are in smallest units (string).
    pub payments: Vec<RecipientPayment>,
    /// Optional notes — stored on the header intent.
    pub notes: Option<String>,
    /// Slippage tolerance in bps applied to every quote. Defaults to 100 (1%).
    pub slippage_tolerance: Option<u32>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecipientPayment {
    /// Destination address. NEAR account or external chain address.
    pub recipient: String,
    /// Amount this recipient should receive, in smallest units.
    pub amount: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkPaymentPrepareResponse {
    /// Account id of the per-DAO bulk-payment subaccount.
    pub bulk_account_id: String,
    /// Header intent hash — goes into the v1.signer FunctionCall args.
    pub header_payload_hash: String,
    /// Recipient intent hashes — go into the proposal description CSV.
    pub recipient_payload_hashes: Vec<String>,
}

/// Default deadline for confidential bulk quotes/intents — long enough that
/// the proposal can wait through the DAO voting period.
fn default_deadline() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() + Duration::hours(24)
}

/// Build a 1Click quote body for a recipient leg (sub → recipient).
/// No app fee on bulk legs.
///
/// near.com → destinationAsset = originAsset, recipientType =
/// CONFIDENTIAL_INTENTS, recipient prefixed with `near:`.
/// Cross-chain → destinationAsset is the picked bridge asset id,
/// recipientType = DESTINATION_CHAIN, raw external address.
#[allow(clippy::too_many_arguments)]
fn build_recipient_quote_body(
    state: &Arc<AppState>,
    dao_id: &str,
    payment: &RecipientPayment,
    origin_asset: &str,
    destination_asset: &str,
    to_near_com: bool,
    deadline: &str,
    slippage: u32,
) -> Value {
    let recipient_type = if to_near_com {
        "CONFIDENTIAL_INTENTS"
    } else {
        "DESTINATION_CHAIN"
    };

    let mut body = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": slippage,
        "originAsset": origin_asset,
        "depositType": "CONFIDENTIAL_INTENTS",
        "destinationAsset": destination_asset,
        "amount": payment.amount,
        "refundTo": dao_id,
        "refundType": "CONFIDENTIAL_INTENTS",
        "recipient": payment.recipient,
        "recipientType": recipient_type,
        "deadline": deadline,
        "quoteWaitingTimeMs": 5000,
    });

    if let Some(referral) = state.env_vars.oneclick_referral.as_ref() {
        body["referral"] = json!(referral);
    }
    body
}

/// Build a 1Click quote body for the header leg (DAO → sub on intents.near).
/// Origin == destination == same Intents asset, recipient is the bulk
/// subaccount inside intents.near. No app fee (same-token transfer).
fn build_header_quote_body(
    state: &Arc<AppState>,
    dao_id: &str,
    sub_id: &str,
    origin_asset: &str,
    total_amount: &str,
    deadline: &str,
) -> Value {
    let mut body = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": 100,
        "originAsset": origin_asset,
        "depositType": "CONFIDENTIAL_INTENTS",
        "destinationAsset": origin_asset,
        "amount": total_amount,
        "refundTo": dao_id,
        "refundType": "CONFIDENTIAL_INTENTS",
        "recipient": sub_id,
        "recipientType": "CONFIDENTIAL_INTENTS",
        "deadline": deadline,
        "quoteWaitingTimeMs": 5000,
    });
    if let Some(referral) = state.env_vars.oneclick_referral.as_ref() {
        body["referral"] = json!(referral);
    }
    body
}

/// Call 1Click `/v0/quote` then `/v0/generate-intent` for one leg.
/// Returns (`payload_hash`, full quote response, intent payload).
async fn quote_and_generate(
    state: &Arc<AppState>,
    access_token: &str,
    quote_body: &Value,
    signer_id: &str,
) -> Result<(String, Value, Value), (StatusCode, String)> {
    // Quote
    let quote_url = format!("{}/v0/quote", state.env_vars.confidential_api_url);
    let quote_response = crate::handlers::intents::quote::send_oneclick_request(
        state,
        &quote_url,
        quote_body,
        Some(access_token),
    )
    .await?;

    let deposit_address = quote_response
        .get("quote")
        .and_then(|q| q.get("depositAddress"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "1Click quote response missing quote.depositAddress".to_string(),
            )
        })?
        .to_string();

    // Generate-intent
    let gen_url = format!("{}/v0/generate-intent", state.env_vars.confidential_api_url);
    let gen_body = json!({
        "type": "swap_transfer",
        "standard": "nep413",
        "depositAddress": deposit_address,
        "signerId": signer_id,
    });
    let gen_response = crate::handlers::intents::quote::send_oneclick_request(
        state,
        &gen_url,
        &gen_body,
        Some(access_token),
    )
    .await?;

    let payload = gen_response
        .get("intent")
        .and_then(|i| i.get("payload"))
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                "generate-intent response missing intent.payload".to_string(),
            )
        })?
        .clone();

    let payload_hash = crate::handlers::relay::confidential::compute_nep413_hash(&payload)
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to compute NEP-413 payload hash".to_string(),
            )
        })?;

    Ok((payload_hash, quote_response, payload))
}

/// Column-major batch of generated intent legs, ready to feed straight into
/// the `UNNEST(...)` insert — no intermediate per-row struct allocations
/// or extra walks.
#[derive(Default)]
struct LegBatch {
    dao_ids: Vec<String>,
    payload_hashes: Vec<String>,
    intent_payloads: Vec<Value>,
    quote_metadatas: Vec<Value>,
    correlation_ids: Vec<Option<String>>,
    intent_types: Vec<String>,
    notes: Vec<Option<String>>,
}

impl LegBatch {
    fn with_capacity(n: usize) -> Self {
        Self {
            dao_ids: Vec::with_capacity(n),
            payload_hashes: Vec::with_capacity(n),
            intent_payloads: Vec::with_capacity(n),
            quote_metadatas: Vec::with_capacity(n),
            correlation_ids: Vec::with_capacity(n),
            intent_types: Vec::with_capacity(n),
            notes: Vec::with_capacity(n),
        }
    }

    fn push(
        &mut self,
        dao_id: String,
        payload_hash: String,
        intent_payload: Value,
        quote_metadata: Value,
        intent_type: &str,
        notes: Option<String>,
    ) {
        let correlation_id = quote_metadata
            .get("correlationId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        self.dao_ids.push(dao_id);
        self.payload_hashes.push(payload_hash);
        self.intent_payloads.push(intent_payload);
        self.quote_metadatas.push(quote_metadata);
        self.correlation_ids.push(correlation_id);
        self.intent_types.push(intent_type.to_string());
        self.notes.push(notes);
    }
}

pub async fn bulk_payment_prepare(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<BulkPaymentPrepareRequest>,
) -> Result<Json<BulkPaymentPrepareResponse>, (StatusCode, String)> {
    let dao_account: AccountId = request.dao_id.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("Invalid dao_id {}: {}", request.dao_id, e),
        )
    })?;

    auth_user
        .verify_dao_member(&state.db_pool, &dao_account)
        .await
        .map_err(|e| (StatusCode::FORBIDDEN, format!("Not a DAO member: {}", e)))?;

    if request.payments.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "payments must be non-empty".into()));
    }

    if request.payments.len() > MAX_RECIPIENTS_PER_BULK_PAYMENT {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Maximum number of recipients per bulk payment is {}",
                MAX_RECIPIENTS_PER_BULK_PAYMENT
            ),
        ));
    }

    let account_plan = get_account_plan_info(&state.db_pool, &request.dao_id)
        .await
        .map_err(|e| {
            tracing::error!(
                "Failed to fetch account plan info for {}: {}",
                request.dao_id,
                e
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to check subscription status: {}", e),
            )
        })?;

    match &account_plan {
        Some(plan) => {
            if plan.batch_payment_credits <= 0 {
                return Err((
                    StatusCode::PAYMENT_REQUIRED,
                    format!(
                        "Insufficient batch payment credits. Your treasury has {} credits remaining. Please upgrade your plan or wait for the monthly reset.",
                        plan.batch_payment_credits
                    ),
                ));
            }
            tracing::info!(
                "Treasury {} has {} batch payment credits available",
                request.dao_id,
                plan.batch_payment_credits
            );
        }
        None => {
            tracing::warn!(
                "Treasury {} not found in monitored accounts. Proceeding without credit check.",
                request.dao_id
            );
        }
    }

    let dao_account_id: near_api::AccountId = request
        .dao_id
        .parse()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid dao_id: {}", e)))?;
    let factory_id = state.bulk_payment_contract_id.clone();
    let sub_id = derive_bulk_subaccount_id(&dao_account_id, &factory_id)?;
    let sub_id_str = sub_id.to_string();

    // Both legs go through the confidential 1Click API, but use different
    // signer JWTs: recipient legs are signed by the sub, header by the DAO.
    let dao_token =
        crate::handlers::intents::confidential::refresh_dao_jwt(&state, &dao_account).await?;
    let sub_token =
        crate::handlers::intents::confidential::refresh_bulk_dao_jwt(&state, &request.dao_id)
            .await?;

    let deadline = default_deadline()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let slippage = request.slippage_tolerance.unwrap_or(100);

    let destination_asset: &str = if request.to_near_com {
        request.origin_asset.as_str()
    } else {
        request.destination_asset.as_deref().ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "destinationAsset is required when toNearCom is false".to_string(),
            )
        })?
    };

    // ── Generate all legs in memory before touching the DB ──────────────
    // Recipient legs are independent → run quote+generate in parallel.
    // First failure short-circuits via try_join_all; nothing is persisted.
    let recipient_signer_id = sub_id_str.clone();
    let recipient_futures = request.payments.iter().map(|payment| {
        let state = state.clone();
        let dao_id = request.dao_id.clone();
        let origin = request.origin_asset.clone();
        let dest = destination_asset.to_string();
        let deadline = deadline.clone();
        let sub_token = sub_token.clone();
        let signer = recipient_signer_id.clone();
        let to_near_com = request.to_near_com;
        async move {
            let body = build_recipient_quote_body(
                &state,
                &dao_id,
                payment,
                &origin,
                &dest,
                to_near_com,
                &deadline,
                slippage,
            );
            quote_and_generate(&state, &sub_token, &body, &signer).await
        }
    });
    let recipient_results: Vec<(String, Value, Value)> =
        futures::future::try_join_all(recipient_futures).await?;

    // +1 for the header leg appended below.
    let mut batch = LegBatch::with_capacity(recipient_results.len() + 1);
    let mut recipient_hashes: Vec<String> = Vec::with_capacity(recipient_results.len());
    let mut total_amount_in: u128 = 0;
    for (hash, quote_response, payload) in recipient_results {
        let amount_in = quote_response
            .get("quote")
            .and_then(|q| q.get("amountIn"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                (
                    StatusCode::BAD_GATEWAY,
                    "recipient quote missing quote.amountIn".to_string(),
                )
            })?;
        let parsed = amount_in.parse::<u128>().map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("recipient amountIn not numeric: {}", e),
            )
        })?;
        total_amount_in = total_amount_in.checked_add(parsed).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "total amount overflow u128".to_string(),
            )
        })?;

        recipient_hashes.push(hash.clone());
        batch.push(
            dao_account_id.to_string(),
            hash,
            payload,
            quote_response,
            "bulk_recipient",
            None,
        );
    }

    let header_signer_id = request.dao_id.clone();
    let total_amount_str = total_amount_in.to_string();
    let header_body = build_header_quote_body(
        &state,
        &request.dao_id,
        &sub_id_str,
        &request.origin_asset,
        &total_amount_str,
        &deadline,
    );
    let (header_hash, header_quote, header_payload) =
        quote_and_generate(&state, &dao_token, &header_body, &header_signer_id).await?;

    batch.push(
        request.dao_id.clone(),
        header_hash.clone(),
        header_payload,
        header_quote,
        "shield",
        request.notes.clone(),
    );

    // ── Atomic persist (single transaction) ─────────────────────────────
    let mut tx = state.db_pool.begin().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to open DB transaction: {}", e),
        )
    })?;

    sqlx::query!(
        r#"
        INSERT INTO confidential_intents (
            dao_id, payload_hash, intent_payload, correlation_id,
            quote_metadata, notes, intent_type, status
        )
        SELECT * FROM UNNEST(
            $1::TEXT[], $2::TEXT[], $3::JSONB[], $4::TEXT[],
            $5::JSONB[], $6::TEXT[], $7::TEXT[]
        ) AS t(dao_id, payload_hash, intent_payload, correlation_id, quote_metadata, notes, intent_type),
        (SELECT 'pending'::TEXT AS status) s
        ON CONFLICT (dao_id, payload_hash) DO UPDATE SET
            intent_payload = EXCLUDED.intent_payload,
            correlation_id = EXCLUDED.correlation_id,
            quote_metadata = EXCLUDED.quote_metadata,
            notes = EXCLUDED.notes,
            intent_type = EXCLUDED.intent_type,
            status = 'pending',
            submit_result = NULL,
            updated_at = NOW()
        "#,
        &batch.dao_ids,
        &batch.payload_hashes,
        &batch.intent_payloads,
        &batch.correlation_ids as _,
        &batch.quote_metadatas,
        &batch.notes as _,
        &batch.intent_types,
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to bulk-insert intents: {}", e),
        )
    })?;

    sqlx::query!(
        r#"
        INSERT INTO confidential_bulk_payments (
            dao_id, bulk_account_id, header_payload_hash,
            recipient_payload_hashes, status
        )
        VALUES ($1, $2, $3, $4, 'pending')
        ON CONFLICT (dao_id, header_payload_hash) DO UPDATE SET
            recipient_payload_hashes = EXCLUDED.recipient_payload_hashes,
            bulk_account_id = EXCLUDED.bulk_account_id,
            status = 'pending',
            last_error = NULL,
            proposal_id = NULL,
            updated_at = NOW()
        "#,
        request.dao_id,
        sub_id_str,
        header_hash,
        &recipient_hashes,
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to persist bulk-payment record: {}", e),
        )
    })?;

    tx.commit().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to commit bulk-payment transaction: {}", e),
        )
    })?;

    tracing::info!(
        "Confidential bulk payment prepared for treasury {}. Decrementing credits...",
        request.dao_id
    );

    let db_result = sqlx::query_as::<_, (i32,)>(
        r#"
        UPDATE monitored_accounts
        SET batch_payment_credits = GREATEST(batch_payment_credits - 1, 0),
            updated_at = NOW()
        WHERE account_id = $1
        RETURNING batch_payment_credits
        "#,
    )
    .bind(&request.dao_id)
    .fetch_optional(&state.db_pool)
    .await;

    match db_result {
        Ok(Some((new_credits,))) => {
            tracing::info!(
                "Successfully decremented credits for treasury {}. New balance: {}",
                request.dao_id,
                new_credits
            );
        }
        Ok(None) => {
            tracing::warn!(
                "Treasury {} not found in monitored_accounts, credits not decremented",
                request.dao_id
            );
        }
        Err(e) => {
            tracing::error!(
                "Failed to decrement batch payment credits for {}: {}",
                request.dao_id,
                e
            );
        }
    }

    crate::services::platform_metrics::record_event(
        &state.db_pool,
        &request.dao_id,
        crate::services::platform_metrics::PlatformMetric::BatchPaymentsUsed,
    )
    .await;

    Ok(Json(BulkPaymentPrepareResponse {
        bulk_account_id: sub_id_str,
        header_payload_hash: header_hash,
        recipient_payload_hashes: recipient_hashes,
    }))
}
