use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub enum AuthError {
    InvalidSignature(String),
    InvalidPublicKey(String),
    InvalidNonce(String),
    ExpiredChallenge,
    ChallengeNotFound,
    InvalidToken(String),
    TokenExpired,
    MissingToken,
    RevokedToken,
    DatabaseError(String),
    InternalError(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::InvalidSignature(msg) => write!(f, "Invalid signature: {}", msg),
            AuthError::InvalidPublicKey(msg) => write!(f, "Invalid public key: {}", msg),
            AuthError::InvalidNonce(msg) => write!(f, "Invalid nonce: {}", msg),
            AuthError::ExpiredChallenge => write!(f, "Challenge has expired"),
            AuthError::ChallengeNotFound => write!(f, "Challenge not found"),
            AuthError::InvalidToken(msg) => write!(f, "Invalid token: {}", msg),
            AuthError::TokenExpired => write!(f, "Token has expired"),
            AuthError::MissingToken => write!(f, "Missing authentication token"),
            AuthError::RevokedToken => write!(f, "Token has been revoked or expired"),
            AuthError::DatabaseError(msg) => write!(f, "Database error: {}", msg),
            AuthError::InternalError(msg) => write!(f, "Internal error: {}", msg),
        }
    }
}

impl std::error::Error for AuthError {}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AuthError::InvalidSignature(_) => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::InvalidPublicKey(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AuthError::InvalidNonce(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AuthError::ExpiredChallenge => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::ChallengeNotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AuthError::InvalidToken(_) => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::RevokedToken => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::TokenExpired => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::MissingToken => (StatusCode::UNAUTHORIZED, self.to_string()),
            AuthError::DatabaseError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database error".to_string(),
            ),
            AuthError::InternalError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal error".to_string(),
            ),
        };

        let body = Json(json!({
            "error": message
        }));

        (status, body).into_response()
    }
}
