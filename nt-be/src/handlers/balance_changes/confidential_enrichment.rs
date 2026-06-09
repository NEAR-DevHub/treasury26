//! Goldsky enrichment helpers for confidential DAO outgoing legs.
//!
//! When a confidential DAO approves a swap proposal, the DAO's `act_proposal`
//! spawns a cross-contract call to `v1.signer`. That `v1.signer` execution
//! outcome emits a single `sign: predecessor=AccountId("…"), request=…
//! `sign:` log (legacy `payload_v2: Some(Eddsa(…))` or `payload: Eddsa(…)`), and Goldsky captures it because
//! the log mentions a sputnik-dao account.
//!
//! The log itself tells us both *that* the proposal executed (v1.signer only
//! emits it for the real `sign` call, not for vote-only `act_proposal`s) and
//! *which* confidential intent it corresponds to (via the payload hash). We
//! use it to synthesize an outgoing `balance_change` from the stored
//! `confidential_intents.quote_metadata`.

use bigdecimal::{BigDecimal, Zero};
use near_api::NetworkConfig;
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::counterparty::{convert_raw_to_decimal, ensure_ft_metadata};
use crate::handlers::intents::confidential::bronze::store::link_intent_to_history_event;
use crate::handlers::intents::confidential::gold::history_events::refresh_gold_metadata_for_intent;
use crate::handlers::intents::confidential::types::{accounts_equal, bare_account};

/// Legacy payload form: `predecessor=AccountId("…") … payload_v2: Some(Eddsa(Bytes("<hex>")))`.
static V1_SIGNER_HEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"predecessor=AccountId\("(?P<dao>[^"]+)"\).*payload_v2:\s*Some\(Eddsa\(Bytes\("(?P<hash>[0-9a-fA-F]+)"\)"#,
    )
    .expect("v1.signer hex sign-log regex is valid")
});

/// `payload_v2: Some(Eddsa(BoundedVec { inner: [u8, …] }))` form (2026-05).
static V1_SIGNER_BYTES: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"predecessor=AccountId\("(?P<dao>[^"]+)"\).*payload_v2:\s*Some\(Eddsa\(BoundedVec\s*\{\s*inner:\s*\[(?P<bytes>[0-9,\s]+)\]"#,
    )
    .expect("v1.signer bytes sign-log regex is valid")
});

/// `payload: Eddsa(BoundedVec { inner: [u8, …], witness: … })` form (2026-06+).
static V1_SIGNER_PAYLOAD_BOUNDED: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"predecessor=AccountId\("(?P<dao>[^"]+)"\).*payload:\s*Eddsa\(BoundedVec\s*\{\s*inner:\s*\[(?P<bytes>[0-9,\s]+)\]"#,
    )
    .expect("v1.signer payload bounded sign-log regex is valid")
});

/// Extracted signal that a confidential sign call ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfidentialSignCall {
    pub dao_id: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone)]
pub struct SubmittedIntentInfo {
    pub recipient: Option<String>,
}

fn decode_bounded_vec_bytes(captured: &str) -> Option<String> {
    let mut hex = String::with_capacity(64);
    for token in captured.split(',') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        let byte: u8 = trimmed.parse().ok()?;
        hex.push_str(&format!("{:02x}", byte));
    }
    if hex.is_empty() { None } else { Some(hex) }
}

/// Scan a `v1.signer` outcome's logs for a `sign: predecessor=…` line and
/// extract the DAO + payload hash if present. Supports `Bytes("<hex>")`,
/// `payload_v2: Some(Eddsa(BoundedVec …))`, and `payload: Eddsa(BoundedVec …)`.
pub fn extract_sign_call_from_logs(logs: &str) -> Option<ConfidentialSignCall> {
    for raw_line in logs.split('\n').flat_map(|l| l.split("\\n")) {
        let line = raw_line.trim();
        if !line.starts_with("sign:") {
            continue;
        }
        if let Some(cap) = V1_SIGNER_HEX.captures(line) {
            return Some(ConfidentialSignCall {
                dao_id: cap.name("dao")?.as_str().to_string(),
                payload_hash: cap.name("hash")?.as_str().to_ascii_lowercase(),
            });
        }
        if let Some(cap) = V1_SIGNER_BYTES.captures(line) {
            return Some(ConfidentialSignCall {
                dao_id: cap.name("dao")?.as_str().to_string(),
                payload_hash: decode_bounded_vec_bytes(cap.name("bytes")?.as_str())?,
            });
        }
        if let Some(cap) = V1_SIGNER_PAYLOAD_BOUNDED.captures(line) {
            return Some(ConfidentialSignCall {
                dao_id: cap.name("dao")?.as_str().to_string(),
                payload_hash: decode_bounded_vec_bytes(cap.name("bytes")?.as_str())?,
            });
        }
    }
    None
}

fn quote_recipient(quote_metadata: Option<&Value>) -> Option<String> {
    let recipient = quote_metadata?
        .get("quoteRequest")
        .and_then(|q| q.get("recipient"))
        .and_then(|v| v.as_str())?;
    Some(bare_account(recipient))
}

pub async fn mark_confidential_intent_submitted(
    app_pool: &PgPool,
    dao_id: &str,
    payload_hash: &str,
    proposal_executed_at: chrono::DateTime<chrono::Utc>,
    proposal_execution_block_height: Option<i64>,
    proposal_execution_transaction_hash: Option<&str>,
) -> Result<Option<SubmittedIntentInfo>, Box<dyn std::error::Error>> {
    let row = sqlx::query_as::<_, (Option<Value>,)>(
        r#"
        SELECT quote_metadata
        FROM confidential_intents
        WHERE dao_id = $1
          AND payload_hash = $2
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .fetch_optional(app_pool)
    .await?;

    let Some((quote_metadata,)) = row else {
        return Ok(None);
    };
    let recipient = quote_recipient(quote_metadata.as_ref());

    sqlx::query(
        r#"
        UPDATE confidential_intents
        SET status = 'submitted',
            proposal_executed_at = COALESCE(proposal_executed_at, $3),
            proposal_execution_block_height = COALESCE(proposal_execution_block_height, $4),
            proposal_execution_transaction_hash = COALESCE(proposal_execution_transaction_hash, $5),
            updated_at = NOW()
        WHERE dao_id = $1
          AND payload_hash = $2
        "#,
    )
    .bind(dao_id)
    .bind(payload_hash)
    .bind(proposal_executed_at)
    .bind(proposal_execution_block_height)
    .bind(proposal_execution_transaction_hash)
    .execute(app_pool)
    .await?;

    if let Some(history_event_id) =
        link_intent_to_history_event(app_pool, dao_id, payload_hash).await?
    {
        tracing::info!(
            "linked submitted intent {}/{} to history_event_id={}",
            dao_id,
            payload_hash,
            history_event_id
        );
    }

    refresh_gold_metadata_for_intent(app_pool, dao_id, payload_hash).await?;

    Ok(Some(SubmittedIntentInfo { recipient }))
}

/// Synthesize an outgoing `balance_change` row for a confidential DAO's swap
/// based on the stored `confidential_intents.quote_metadata`.
///
/// Returns `Ok(true)` if a row was written, `Ok(false)` if no matching intent
/// record was found.
// TODO(confidential-v2): remove this legacy public `balance_changes` writer
// once `gold_confidential_history_events` backs list/chart/export reads.
#[allow(clippy::too_many_arguments)]
pub async fn handle_confidential_outgoing(
    app_pool: &PgPool,
    network: &NetworkConfig,
    dao_id: &str,
    payload_hash: &str,
    block_height: i64,
    block_timestamp_nanos: i64,
    block_time: chrono::DateTime<chrono::Utc>,
    transaction_hash: Option<String>,
    signer_id: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error>> {
    let row = sqlx::query!(
        r#"
        SELECT quote_metadata, correlation_id
        FROM confidential_intents
        WHERE dao_id = $1 AND payload_hash = $2
        "#,
        dao_id,
        payload_hash,
    )
    .fetch_optional(app_pool)
    .await?;

    let Some(row) = row else {
        tracing::warn!(
            "No confidential_intents row for dao={} payload_hash={}",
            dao_id,
            payload_hash
        );
        return Ok(false);
    };

    let Some(quote_metadata) = row.quote_metadata else {
        tracing::warn!(
            "confidential_intents for dao={} payload_hash={} has no quote_metadata",
            dao_id,
            payload_hash
        );
        return Ok(false);
    };

    let origin_raw = quote_metadata
        .get("quoteRequest")
        .and_then(|q| q.get("originAsset"))
        .and_then(|v| v.as_str());
    let destination_raw = quote_metadata
        .get("quoteRequest")
        .and_then(|q| q.get("destinationAsset"))
        .and_then(|v| v.as_str());
    let amount_in_raw = quote_metadata
        .get("quote")
        .and_then(|q| q.get("amountIn"))
        .and_then(|v| v.as_str());
    let amount_out_raw = quote_metadata
        .get("quote")
        .and_then(|q| q.get("amountOut"))
        .and_then(|v| v.as_str());
    let recipient = quote_metadata
        .get("quoteRequest")
        .and_then(|q| q.get("recipient"))
        .and_then(|v| v.as_str())
        .map(bare_account);
    let (Some(origin_raw), Some(amount_in_raw)) = (origin_raw, amount_in_raw) else {
        tracing::warn!(
            "quote_metadata for dao={} payload_hash={} missing originAsset or amountIn",
            dao_id,
            payload_hash
        );
        return Ok(false);
    };

    // Counterparty convention:
    //   - `recipient != dao_id` → payment (tokens leave the DAO for an external
    //     account; may include a swap hop on the way). Counterparty = recipient.
    //   - `recipient == dao_id` → self-swap. Counterparty = "intents.near", which
    //     mirrors the public intents pipeline so the UI renders public and
    //     confidential swaps identically.
    let counterparty: String = match recipient.as_deref() {
        Some(r) if !accounts_equal(r, dao_id) => r.to_string(),
        _ => "intents.near".to_string(),
    };

    let storage_token_id = format!("intents.near:{}", origin_raw);
    let decimals = ensure_ft_metadata(app_pool, network, &storage_token_id).await?;
    let amount_in = convert_raw_to_decimal(amount_in_raw, decimals)?;

    let last_balance: Option<BigDecimal> = sqlx::query_scalar!(
        r#"
        SELECT balance_after
        FROM balance_changes
        WHERE account_id = $1 AND token_id = $2
        ORDER BY block_height DESC, id DESC
        LIMIT 1
        "#,
        dao_id,
        storage_token_id,
    )
    .fetch_optional(app_pool)
    .await?;

    let balance_before = last_balance.unwrap_or_else(|| amount_in.clone());
    let mut balance_after = &balance_before - &amount_in;
    if balance_after < BigDecimal::zero() {
        balance_after = BigDecimal::zero();
    }
    let amount = -amount_in.clone();

    let transaction_hashes: Vec<String> = transaction_hash.map(|h| vec![h]).unwrap_or_default();
    let raw_data = json!({
        "payload_hash": payload_hash,
        "correlation_id": row.correlation_id,
        "source": "goldsky+1click",
    });

    let deposit_row = sqlx::query!(
        r#"
        INSERT INTO balance_changes
        (account_id, token_id, block_height, block_timestamp, block_time,
         amount, balance_before, balance_after,
         transaction_hashes, receipt_id, signer_id, receiver_id,
         counterparty, actions, raw_data, action_kind, method_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (account_id, block_height, token_id) DO UPDATE SET
          amount = EXCLUDED.amount,
          balance_before = EXCLUDED.balance_before,
          balance_after = EXCLUDED.balance_after,
          transaction_hashes = EXCLUDED.transaction_hashes,
          counterparty = EXCLUDED.counterparty,
          raw_data = EXCLUDED.raw_data,
          action_kind = EXCLUDED.action_kind,
          method_name = EXCLUDED.method_name,
          updated_at = NOW()
        RETURNING id
        "#,
        dao_id,
        storage_token_id,
        block_height,
        block_timestamp_nanos,
        block_time,
        amount,
        balance_before,
        balance_after,
        &transaction_hashes,
        &Vec::<String>::new() as &[String],
        signer_id,
        Some("v1.signer"),
        counterparty,
        json!({}),
        raw_data,
        "TRANSFER",
        Some("act_proposal"),
    )
    .fetch_one(app_pool)
    .await?;

    tracing::info!(
        "Confidential outgoing leg for {}/{} amount=-{} (payload_hash={})",
        dao_id,
        storage_token_id,
        amount_in,
        payload_hash,
    );

    // Pre-seed detected_swaps when the 1Click quote involves a token hop
    // (destinationAsset differs from originAsset). This lets the UI render the
    // outgoing leg as a swap immediately; the poller fills in fulfillment_* on
    // match via the ON CONFLICT upsert.
    if let Some(destination_raw) = destination_raw
        && destination_raw != origin_raw
    {
        let received_storage_id = format!("intents.near:{}", destination_raw);
        let expected_out = match amount_out_raw {
            Some(raw) => match ensure_ft_metadata(app_pool, network, &received_storage_id).await {
                Ok(decimals) => convert_raw_to_decimal(raw, decimals).ok(),
                Err(e) => {
                    tracing::warn!(
                        "ensure_ft_metadata({}) failed: {} — seeding detected_swaps without received_amount",
                        received_storage_id,
                        e
                    );
                    None
                }
            },
            None => None,
        };

        let synthetic_solver_tx = row
            .correlation_id
            .clone()
            .unwrap_or_else(|| format!("1click:{}", payload_hash));

        if let Err(e) = sqlx::query!(
            r#"
            INSERT INTO detected_swaps (
                account_id,
                solver_transaction_hash,
                deposit_balance_change_id,
                deposit_receipt_id,
                sent_token_id,
                sent_amount,
                received_token_id,
                received_amount,
                block_height
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (account_id, solver_transaction_hash) DO UPDATE SET
                deposit_balance_change_id = COALESCE(detected_swaps.deposit_balance_change_id, EXCLUDED.deposit_balance_change_id),
                sent_token_id             = COALESCE(detected_swaps.sent_token_id, EXCLUDED.sent_token_id),
                sent_amount               = COALESCE(detected_swaps.sent_amount, EXCLUDED.sent_amount),
                received_token_id         = COALESCE(detected_swaps.received_token_id, EXCLUDED.received_token_id),
                received_amount           = COALESCE(detected_swaps.received_amount, EXCLUDED.received_amount)
            "#,
            dao_id,
            synthetic_solver_tx,
            Some(deposit_row.id),
            None::<String>,
            Some(&storage_token_id),
            Some(&amount_in),
            received_storage_id,
            expected_out,
            block_height,
        )
        .execute(app_pool)
        .await
        {
            tracing::warn!(
                "pre-seed detected_swaps failed for dao={} payload_hash={}: {}",
                dao_id,
                payload_hash,
                e
            );
        }
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v1_signer_sign_log() {
        let log = r#"sign: predecessor=AccountId("confidential-yuriik.sputnik-dao.near"), request=SignRequestArgs { path: "confidential-yuriik.sputnik-dao.near", payload_v2: Some(Eddsa(Bytes("2591e2441a7d9c0b3b9fed73da21609cd708db1e5316f8b244630191d574adb4"))), deprecated_payload: None, domain_id: Some(DomainId(1)), deprecated_key_version: None }"#;
        let got = extract_sign_call_from_logs(log).expect("should parse");
        assert_eq!(got.dao_id, "confidential-yuriik.sputnik-dao.near");
        assert_eq!(
            got.payload_hash,
            "2591e2441a7d9c0b3b9fed73da21609cd708db1e5316f8b244630191d574adb4"
        );
    }

    #[test]
    fn ignores_non_sign_logs() {
        assert!(extract_sign_call_from_logs("EVENT_JSON:{\"standard\":\"nep141\"}").is_none());
        assert!(extract_sign_call_from_logs("Transfer 100 from a to b").is_none());
    }

    #[test]
    fn parses_v1_signer_bounded_vec_payload() {
        // Real on-chain log captured 2026-05-08, block 197405271 (tobi.sputnik-dao.near).
        // The signer contract upgraded from `Bytes("<hex>")` to `BoundedVec { inner: [u8;32] }`.
        let log = r#"sign: predecessor=AccountId("tobi.sputnik-dao.near"), request=SignRequestArgs { path: "tobi.sputnik-dao.near", payload_v2: Some(Eddsa(BoundedVec { inner: [123, 162, 50, 88, 71, 237, 138, 108, 13, 213, 18, 249, 177, 240, 169, 135, 202, 61, 156, 80, 85, 206, 77, 114, 62, 140, 72, 88, 191, 215, 42, 171] })), deprecated_payload: None, domain_id: Some(DomainId(1)), deprecated_key_version: None }"#;
        let got = extract_sign_call_from_logs(log).expect("should parse new format");
        assert_eq!(got.dao_id, "tobi.sputnik-dao.near");
        assert_eq!(
            got.payload_hash,
            "7ba2325847ed8a6c0dd512f9b1f0a987ca3d9c5055ce4d723e8c4858bfd72aab"
        );
    }

    #[test]
    fn parses_v1_signer_payload_bounded_vec_with_witness() {
        // Real on-chain log captured 2026-06-04, block 201255187 (dedupingggg.sputnik-dao.near).
        let log = r#"sign: predecessor=AccountId("dedupingggg.sputnik-dao.near"), request=SignRequestArgs { path: "dedupingggg.sputnik-dao.near", payload: Eddsa(BoundedVec { inner: [87, 249, 7, 178, 173, 216, 20, 193, 248, 189, 160, 114, 81, 65, 8, 58, 29, 224, 170, 146, 94, 100, 237, 122, 74, 216, 231, 25, 0, 252, 238, 243], witness: NonEmpty(()) }), domain_id: DomainId(1) }"#;
        let got = extract_sign_call_from_logs(log).expect("should parse payload: form");
        assert_eq!(got.dao_id, "dedupingggg.sputnik-dao.near");
        assert_eq!(
            got.payload_hash,
            "57f907b2add814c1f8bda0725141083a1de0aa925e64ed7a4ad8e71900fceef3"
        );
    }
}
