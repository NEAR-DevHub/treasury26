use crate::auth::AuthError;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// JWT claims structure
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    /// Subject (account_id)
    pub sub: String,
    /// Expiration time (Unix timestamp)
    pub exp: usize,
    /// Issued at (Unix timestamp)
    pub iat: usize,
}

/// Result of creating a JWT token
pub struct JwtCreateResult {
    pub token: String,
    pub token_hash: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Create a new JWT token for the given account_id
/// Returns the token, its hash (for storage), and expiration time
pub fn create_jwt(
    account_id: &str,
    secret: &[u8],
    expiry_hours: u64,
) -> Result<JwtCreateResult, AuthError> {
    let now = chrono::Utc::now();
    let expiry = now + chrono::Duration::hours(expiry_hours as i64);

    let claims = Claims {
        sub: account_id.to_string(),
        exp: expiry.timestamp() as usize,
        iat: now.timestamp() as usize,
    };

    let header = Header::new(Algorithm::HS256);
    let key = EncodingKey::from_secret(secret);

    let token = encode(&header, &claims, &key)
        .map_err(|e| AuthError::InternalError(format!("Failed to create JWT: {}", e)))?;

    // Create a hash of the token for storage (we don't store the actual token)
    let token_hash = hash_token(&token);

    Ok(JwtCreateResult {
        token,
        token_hash,
        expires_at: expiry,
    })
}

/// Verify a JWT token and return the claims
pub fn verify_jwt(token: &str, secret: &[u8]) -> Result<Claims, AuthError> {
    let key = DecodingKey::from_secret(secret);
    let validation = Validation::new(Algorithm::HS256);

    let token_data = decode::<Claims>(token, &key, &validation).map_err(|e| match e.kind() {
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => AuthError::TokenExpired,
        _ => AuthError::InvalidToken(format!("Failed to verify JWT: {}", e)),
    })?;

    Ok(token_data.claims)
}

/// Hash a token for storage (we don't store actual tokens)
pub fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_and_verify_jwt() {
        let secret = b"test-secret-key-for-jwt";
        let account_id = "test.near";

        let token = create_jwt(account_id, secret, 1).expect("Failed to create JWT");
        let claims = verify_jwt(&token.token, secret).expect("Failed to verify JWT");

        assert_eq!(claims.sub, account_id);
    }

    #[test]
    fn test_verify_invalid_jwt() {
        let secret = b"test-secret-key-for-jwt";
        let result = verify_jwt("invalid-token", secret);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_jwt_wrong_secret() {
        let secret1 = b"secret-1";
        let secret2 = b"secret-2";
        let account_id = "test.near";

        let token = create_jwt(account_id, secret1, 1).expect("Failed to create JWT");
        let result = verify_jwt(&token.token, secret2);
        assert!(result.is_err());
    }
}
