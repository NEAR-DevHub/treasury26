use axum::{Json, extract::State, http::StatusCode};
use borsh::BorshDeserialize;
use near_api::{
    Transaction,
    types::{Action, json::Base64VecU8, transaction::delegate_action::SignedDelegateAction},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{
    AppState,
    auth::AuthUser,
    config::plans::{PlanType, has_gas_covered_credits},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub treasury_id: String,
    /// Base64-encoded borsh-serialized SignedDelegateAction
    pub signed_delegate_action: Base64VecU8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn error_response(status: StatusCode, msg: String) -> (StatusCode, Json<RelayResponse>) {
    (
        status,
        Json(RelayResponse {
            success: false,
            error: Some(msg),
        }),
    )
}

/// Relay a signed delegate action (NEP-366 meta-transaction) to the NEAR network.
///
/// The backend wraps the user's signed delegate action in a regular transaction,
/// signs it with the relayer key (paying for gas), and submits to the network.
/// On success, decrements the treasury's gas-covered transaction credits.
pub async fn relay_delegate_action(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, (StatusCode, Json<RelayResponse>)> {
    // Step 1: Decode base64 to bytes

    let signed_delegate_action =
        SignedDelegateAction::try_from_slice(&request.signed_delegate_action.0).map_err(|e| {
            error_response(
                StatusCode::BAD_REQUEST,
                format!("Invalid delegate action: {}", e),
            )
        })?;

    // Step 3: Verify sender_id matches authenticated user
    let sender_id = signed_delegate_action.delegate_action.sender_id.to_string();
    if sender_id != auth_user.account_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            format!(
                "Delegate action sender '{}' does not match authenticated user '{}'",
                sender_id, auth_user.account_id
            ),
        ));
    }

    // Step 4: Check gas-covered transaction credits
    let credits_result = sqlx::query_as::<_, (i32, PlanType)>(
        r#"
        SELECT gas_covered_transactions, plan_type
        FROM monitored_accounts
        WHERE account_id = $1
        "#,
    )
    .bind(&request.treasury_id)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Database error: {}", e),
        )
    })?;

    match credits_result {
        None => {
            return Err(error_response(
                StatusCode::NOT_FOUND,
                format!(
                    "Treasury '{}' not found in monitored accounts",
                    request.treasury_id
                ),
            ));
        }
        Some((current_credits, plan_type)) => {
            if !has_gas_covered_credits(plan_type, current_credits) {
                return Err(error_response(
                    StatusCode::PAYMENT_REQUIRED,
                    "No gas-covered transaction credits remaining. Please upgrade your plan."
                        .to_string(),
                ));
            }
        }
    }

    // Step 5: Build and send the wrapping transaction
    // Per NEP-366, the relayer sends a transaction to the delegate action's sender_id
    let receiver_id = signed_delegate_action.delegate_action.sender_id.clone();

    let execution_result = Transaction::construct(state.signer_id.clone(), receiver_id)
        .add_action(Action::Delegate(Box::new(signed_delegate_action)))
        .with_signer(state.signer.clone())
        .send_to(&state.network)
        .await;

    match execution_result {
        Ok(result) => match result.into_result() {
            Ok(_) => {
                // Step 6: Decrement gas-covered transaction credits
                let db_result = sqlx::query_as::<_, (i32,)>(
                    r#"
                    UPDATE monitored_accounts
                    SET gas_covered_transactions = GREATEST(gas_covered_transactions - 1, 0),
                        updated_at = NOW()
                    WHERE account_id = $1
                    RETURNING gas_covered_transactions
                    "#,
                )
                .bind(&request.treasury_id)
                .fetch_optional(&state.db_pool)
                .await;

                match db_result {
                    Ok(Some((new_credits,))) => {
                        log::info!(
                            "Decremented gas credits for treasury {}. New balance: {}",
                            request.treasury_id,
                            new_credits
                        );
                    }
                    Ok(None) => {
                        log::warn!(
                            "Treasury {} not found for credit decrement",
                            request.treasury_id
                        );
                    }
                    Err(e) => {
                        log::error!(
                            "Failed to decrement gas credits for {}: {}",
                            request.treasury_id,
                            e
                        );
                        // Don't fail - the relay already succeeded
                    }
                }

                Ok(Json(RelayResponse {
                    success: true,
                    error: None,
                }))
            }
            Err(e) => {
                log::error!("Delegate action execution failed: {:?}", e);
                Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Execution failed: {}", e),
                ))
            }
        },
        Err(e) => {
            log::error!("Failed to relay delegate action: {:?}", e);
            Err(error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to relay: {}", e),
            ))
        }
    }
}
