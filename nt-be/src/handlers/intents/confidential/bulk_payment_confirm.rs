//! Confirm a prepared confidential bulk-payment at submit time.
//!
//! `bulk_payment_prepare` runs when the review screen loads, so a user who
//! only browses to review must see no consequence (no credit spent, no
//! metric recorded). The side effects that belong to an actual submission
//! live here instead:
//!   1. attach the requestor's notes (typed on the review screen, i.e.
//!      after prepare fired) to the header intent row
//!   2. consume one batch-payment credit + record the usage metric.
//!
//! The FE calls this once with the header hash from the in-memory prepare
//! response, right before creating the DAO proposal.

use axum::{Json, extract::State, http::StatusCode};
use near_api::AccountId;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{AppState, auth::AuthUser};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkPaymentConfirmRequest {
    /// DAO account id ("<prefix>.sputnik-dao.near").
    pub dao_id: String,
    /// Header intent hash from the prepare response being confirmed.
    pub header_payload_hash: String,
    /// Requestor notes — stored privately on the header intent row and
    /// surfaced via confidential_metadata to authenticated DAO members.
    pub notes: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkPaymentConfirmResponse {
    pub success: bool,
}

pub async fn bulk_payment_confirm(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<BulkPaymentConfirmRequest>,
) -> Result<Json<BulkPaymentConfirmResponse>, (StatusCode, String)> {
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

    // The hash must belong to a prepared, not-yet-voted bulk payment of this
    // DAO — guards against burning credits on arbitrary or replayed hashes.
    let prepared_exists = sqlx::query_scalar::<_, i32>(
        r#"
        SELECT 1 FROM confidential_bulk_payments
        WHERE dao_id = $1 AND header_payload_hash = $2 AND status = 'pending'
        "#,
    )
    .bind(&request.dao_id)
    .bind(&request.header_payload_hash)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to look up prepared bulk payment: {}", e),
        )
    })?;

    if prepared_exists.is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            "No prepared bulk payment found for this header hash".to_string(),
        ));
    }

    if let Some(notes) = request.notes.as_ref().filter(|n| !n.is_empty()) {
        sqlx::query(
            r#"
            UPDATE confidential_intents
            SET notes = $3, updated_at = NOW()
            WHERE dao_id = $1 AND payload_hash = $2
            "#,
        )
        .bind(&request.dao_id)
        .bind(&request.header_payload_hash)
        .bind(notes)
        .execute(&state.db_pool)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to store bulk payment notes: {}", e),
            )
        })?;
    }

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

    Ok(Json(BulkPaymentConfirmResponse { success: true }))
}

#[cfg(test)]
mod tests {
    use crate::{
        routes::create_routes,
        utils::test_utils::{
            DAO_ID, USER_ACCOUNT_ID, issue_auth_cookie, seed_policy_member, send, test_state,
        },
    };
    use axum::http::StatusCode;
    use serde_json::{Value, json};
    use sqlx::PgPool;

    const HEADER_HASH: &str = "test-header-payload-hash";

    fn uri() -> String {
        "/api/confidential-intents/bulk-payment/confirm".to_string()
    }

    fn confirm_body(dao_id: &str, header_hash: &str, notes: Option<&str>) -> Value {
        json!({ "daoId": dao_id, "headerPayloadHash": header_hash, "notes": notes })
    }

    /// Seed what `bulk_payment_prepare` leaves behind for a review session: the
    /// bulk-payment row and its header intent row (`intent_type = 'shield'`).
    async fn seed_prepared_bulk_payment(
        pool: &PgPool,
        dao_id: &str,
        header_hash: &str,
        status: &str,
    ) {
        sqlx::query(
            r#"
            INSERT INTO confidential_bulk_payments
                (dao_id, bulk_account_id, header_payload_hash, recipient_payload_hashes, status)
            VALUES ($1, 'sub.bulk-payment.near', $2, ARRAY['recipient-hash-1'], $3)
            "#,
        )
        .bind(dao_id)
        .bind(header_hash)
        .bind(status)
        .execute(pool)
        .await
        .expect("seed confidential bulk payment");

        sqlx::query(
            r#"
            INSERT INTO confidential_intents (dao_id, payload_hash, intent_payload, intent_type)
            VALUES ($1, $2, '{}'::jsonb, 'shield')
            "#,
        )
        .bind(dao_id)
        .bind(header_hash)
        .execute(pool)
        .await
        .expect("seed header intent row");
    }

    async fn set_credits(pool: &PgPool, dao_id: &str, credits: i32) {
        sqlx::query(
            "UPDATE monitored_accounts SET batch_payment_credits = $2 WHERE account_id = $1",
        )
        .bind(dao_id)
        .bind(credits)
        .execute(pool)
        .await
        .expect("set batch payment credits");
    }

    async fn credits_of(pool: &PgPool, dao_id: &str) -> i32 {
        sqlx::query_scalar(
            "SELECT batch_payment_credits FROM monitored_accounts WHERE account_id = $1",
        )
        .bind(dao_id)
        .fetch_one(pool)
        .await
        .expect("read batch payment credits")
    }

    async fn notes_of(pool: &PgPool, dao_id: &str, header_hash: &str) -> Option<String> {
        sqlx::query_scalar(
            "SELECT notes FROM confidential_intents WHERE dao_id = $1 AND payload_hash = $2",
        )
        .bind(dao_id)
        .bind(header_hash)
        .fetch_one(pool)
        .await
        .expect("read header intent notes")
    }

    async fn batch_payments_used(pool: &PgPool, dao_id: &str) -> i64 {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT SUM(batch_payments_used) FROM usage_tracking WHERE monitored_account_id = $1",
        )
        .bind(dao_id)
        .fetch_one(pool)
        .await
        .expect("read batch_payments_used metric")
        .unwrap_or(0)
    }

    #[sqlx::test]
    async fn test_confirm_burns_credit_stores_notes_and_records_metric(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        seed_prepared_bulk_payment(&pool, DAO_ID, HEADER_HASH, "pending").await;
        set_credits(&pool, DAO_ID, 5).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, Some("march payroll"))),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "confirm should succeed: {body}");
        let payload: Value = serde_json::from_str(&body).expect("valid JSON response");
        assert_eq!(payload["success"], true);
        assert_eq!(credits_of(&pool, DAO_ID).await, 4, "one credit consumed");
        assert_eq!(
            notes_of(&pool, DAO_ID, HEADER_HASH).await.as_deref(),
            Some("march payroll"),
            "notes stored on the header intent row"
        );
        assert_eq!(
            batch_payments_used(&pool, DAO_ID).await,
            1,
            "usage metric recorded"
        );
    }

    /// Absent and empty notes must not overwrite what prepare stored — the FE
    /// sends `notes: null` when the user typed nothing on the review screen.
    #[sqlx::test]
    async fn test_confirm_with_no_notes_keeps_prepared_notes(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        seed_prepared_bulk_payment(&pool, DAO_ID, HEADER_HASH, "pending").await;
        sqlx::query(
            "UPDATE confidential_intents SET notes = 'from prepare' WHERE dao_id = $1 AND payload_hash = $2",
        )
        .bind(DAO_ID)
        .bind(HEADER_HASH)
        .execute(&pool)
        .await
        .expect("preset notes");
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app.clone(),
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "confirm without notes: {body}");
        assert_eq!(
            notes_of(&pool, DAO_ID, HEADER_HASH).await.as_deref(),
            Some("from prepare"),
            "null notes must not clear stored notes"
        );

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, Some(""))),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "confirm with empty notes: {body}");
        assert_eq!(
            notes_of(&pool, DAO_ID, HEADER_HASH).await.as_deref(),
            Some("from prepare"),
            "empty notes must not clear stored notes"
        );
    }

    /// The hash guard exists so arbitrary or replayed hashes can't burn credits.
    #[sqlx::test]
    async fn test_confirm_unknown_hash_is_404_with_no_side_effects(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        set_credits(&pool, DAO_ID, 5).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, "no-such-hash", None)),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND, "unknown hash: {body}");
        assert_eq!(credits_of(&pool, DAO_ID).await, 5, "no credit burned");
        assert_eq!(batch_payments_used(&pool, DAO_ID).await, 0, "no metric");
    }

    /// A bulk payment past 'pending' (already picked up by the relay) must not
    /// be confirmable again.
    #[sqlx::test]
    async fn test_confirm_non_pending_bulk_payment_is_404(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        seed_prepared_bulk_payment(&pool, DAO_ID, HEADER_HASH, "completed").await;
        set_credits(&pool, DAO_ID, 5).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND, "completed payment: {body}");
        assert_eq!(credits_of(&pool, DAO_ID).await, 5, "no credit burned");
    }

    /// The lookup is scoped by dao_id: a hash prepared for another DAO must not
    /// confirm under this one.
    #[sqlx::test]
    async fn test_confirm_other_daos_hash_is_404(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        seed_prepared_bulk_payment(&pool, "other-dao.sputnik-dao.near", HEADER_HASH, "pending")
            .await;
        set_credits(&pool, DAO_ID, 5).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND, "other DAO's hash: {body}");
        assert_eq!(credits_of(&pool, DAO_ID).await, 5, "no credit burned");
    }

    #[sqlx::test]
    async fn test_confirm_forbidden_for_non_member(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        // The DAO exists with a prepared payment, but the caller is not a member.
        seed_policy_member(&pool, DAO_ID, "someone-else.near").await;
        seed_prepared_bulk_payment(&pool, DAO_ID, HEADER_HASH, "pending").await;
        set_credits(&pool, DAO_ID, 5).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN, "non-member: {body}");
        assert_eq!(credits_of(&pool, DAO_ID).await, 5, "no credit burned");
        assert_eq!(batch_payments_used(&pool, DAO_ID).await, 0, "no metric");
    }

    #[sqlx::test]
    async fn test_confirm_requires_authentication(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state);

        let (status, body) = send(
            app,
            "POST",
            uri(),
            "",
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED, "no auth cookie: {body}");
    }

    #[sqlx::test]
    async fn test_confirm_invalid_dao_id_is_400(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body("not a valid account id", HEADER_HASH, None)),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "invalid dao_id: {body}");
    }

    /// Confirm never gates on remaining credits (prepare owns out-of-credits
    /// UX); the decrement clamps at zero instead of going negative.
    #[sqlx::test]
    async fn test_confirm_with_zero_credits_succeeds_and_clamps(pool: PgPool) {
        let state = test_state(pool.clone());
        let app = create_routes(state.clone());
        seed_policy_member(&pool, DAO_ID, USER_ACCOUNT_ID).await;
        seed_prepared_bulk_payment(&pool, DAO_ID, HEADER_HASH, "pending").await;
        set_credits(&pool, DAO_ID, 0).await;
        let cookie = issue_auth_cookie(&pool, &state, USER_ACCOUNT_ID).await;

        let (status, body) = send(
            app,
            "POST",
            uri(),
            &cookie,
            Some(confirm_body(DAO_ID, HEADER_HASH, None)),
        )
        .await;

        assert_eq!(
            status,
            StatusCode::OK,
            "zero credits still confirms: {body}"
        );
        assert_eq!(credits_of(&pool, DAO_ID).await, 0, "credits clamp at zero");
        assert_eq!(
            batch_payments_used(&pool, DAO_ID).await,
            1,
            "usage metric still recorded"
        );
    }
}
