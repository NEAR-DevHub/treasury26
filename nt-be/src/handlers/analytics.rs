use axum::{
    Json,
    extract::State,
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, WWW_AUTHENTICATE},
    },
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::AppState;

/// One row of the `kr_analytics_treasury_monthly` view.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TreasuryMonthlyRow {
    pub account_id: String,
    pub month_start: NaiveDate,
    pub month_end: NaiveDate,
    pub year: i32,
    pub month: i32,
    pub month_label: String,
    pub trezu_started_on: NaiveDate,
    pub age_months: i32,
    pub treasury_type: String,
    pub origin: String,
    pub plan_type: Option<String>,
    pub members: i64,
    pub aum_usd: Option<BigDecimal>,
    pub aum_snapshot_at: Option<DateTime<Utc>>,
    pub inflow_usd: BigDecimal,
    pub outflow_usd: BigDecimal,
    pub netflow_usd: BigDecimal,
    pub swap_volume_usd: BigDecimal,
    pub volume_usd: BigDecimal,
    pub utilization_ratio: Option<BigDecimal>,
    pub payments: i64,
    pub votes: i64,
    pub swaps: i64,
    pub batch_payments: i64,
    pub address_book_size: i64,
    pub exports: i64,
    pub gas_covered_transactions: i64,
    pub derived_swap_fee_revenue_usd: BigDecimal,
    pub last_activity_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct TreasuryMonthlyAnalyticsResponse {
    pub count: usize,
    pub rows: Vec<TreasuryMonthlyRow>,
}

const BASIC_AUTH_REALM: &str = "Near Business Analytics";

pub struct ApiError {
    status: StatusCode,
    headers: Option<Box<HeaderMap>>,
    body: Json<Value>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, self.body).into_response();
        if let Some(headers) = self.headers {
            response.headers_mut().extend(*headers);
        }
        response
    }
}

/// Validates the `Authorization` header against either the Basic-auth
/// credentials in `ANALYTICS_USERS` (browser access) or the static
/// `ANALYTICS_API_KEY` (with or without a `Bearer ` prefix). Fails closed when
/// neither is configured; 401 responses carry a `WWW-Authenticate: Basic`
/// challenge so browsers show their native login prompt.
fn require_analytics_auth(
    headers: &HeaderMap,
    users: &[crate::utils::admin_auth::AdminCredential],
    api_key: Option<&str>,
) -> Result<(), ApiError> {
    let unauthorized = || {
        let mut response_headers = HeaderMap::new();
        response_headers.insert(
            WWW_AUTHENTICATE,
            format!("Basic realm=\"{BASIC_AUTH_REALM}\"")
                .parse()
                .unwrap(),
        );
        ApiError {
            status: StatusCode::UNAUTHORIZED,
            headers: Some(Box::new(response_headers)),
            body: Json(json!({ "error": "unauthorized" })),
        }
    };

    let authorization = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(unauthorized)?;

    if let Some(encoded) = authorization.strip_prefix("Basic ") {
        let credentials = STANDARD
            .decode(encoded)
            .ok()
            .and_then(|decoded| String::from_utf8(decoded).ok())
            .ok_or_else(unauthorized)?;
        let (username, password) = credentials.split_once(':').ok_or_else(unauthorized)?;
        return match crate::utils::admin_auth::authenticate_admin(users, username, password) {
            Some(_) => Ok(()),
            None => Err(unauthorized()),
        };
    }

    let expected = api_key.ok_or_else(unauthorized)?;
    let received = authorization
        .strip_prefix("Bearer ")
        .unwrap_or(authorization);
    if crate::utils::admin_auth::constant_time_eq(expected, received) {
        Ok(())
    } else {
        Err(unauthorized())
    }
}

/// GET /internal/api/analytics/treasury-monthly
///
/// Returns every row of the `kr_analytics_treasury_monthly` view, guarded by
/// `ANALYTICS_USERS` Basic auth or the `ANALYTICS_API_KEY` static key.
pub async fn get_treasury_monthly(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<TreasuryMonthlyAnalyticsResponse>, ApiError> {
    require_analytics_auth(
        &headers,
        &state.env_vars.analytics_users,
        state.env_vars.analytics_api_key.as_deref(),
    )?;

    let rows = sqlx::query_as::<_, TreasuryMonthlyRow>(
        r#"
        SELECT *
        FROM kr_analytics_treasury_monthly
        ORDER BY month_start, account_id
        "#,
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| {
        tracing::error!("Failed to load treasury monthly analytics: {e}");
        ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            headers: None,
            body: Json(json!({ "error": "Failed to load treasury analytics." })),
        }
    })?;

    Ok(Json(TreasuryMonthlyAnalyticsResponse {
        count: rows.len(),
        rows,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::admin_auth::parse_admin_users;

    fn headers_with_authorization(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, value.parse().unwrap());
        headers
    }

    fn basic_header(username: &str, password: &str) -> String {
        format!(
            "Basic {}",
            STANDARD.encode(format!("{username}:{password}"))
        )
    }

    #[test]
    fn accepts_valid_basic_credentials() {
        let users = parse_admin_users(Some("viewer:secret"));
        let headers = headers_with_authorization(&basic_header("viewer", "secret"));
        assert!(require_analytics_auth(&headers, &users, None).is_ok());
    }

    #[test]
    fn rejects_wrong_basic_password() {
        let users = parse_admin_users(Some("viewer:secret"));
        let headers = headers_with_authorization(&basic_header("viewer", "wrong"));
        assert!(require_analytics_auth(&headers, &users, None).is_err());
    }

    #[test]
    fn accepts_bearer_api_key() {
        let headers = headers_with_authorization("Bearer key123");
        assert!(require_analytics_auth(&headers, &[], Some("key123")).is_ok());
    }

    #[test]
    fn missing_header_returns_basic_challenge() {
        let error = require_analytics_auth(&HeaderMap::new(), &[], Some("key123")).unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        let response_headers = error.headers.unwrap();
        let challenge = response_headers.get(WWW_AUTHENTICATE).unwrap();
        assert_eq!(
            challenge.to_str().unwrap(),
            format!("Basic realm=\"{BASIC_AUTH_REALM}\"")
        );
    }

    #[test]
    fn fails_closed_when_nothing_configured() {
        let headers = headers_with_authorization(&basic_header("viewer", "secret"));
        assert!(require_analytics_auth(&headers, &[], None).is_err());
        let headers = headers_with_authorization("Bearer key123");
        assert!(require_analytics_auth(&headers, &[], None).is_err());
    }
}
