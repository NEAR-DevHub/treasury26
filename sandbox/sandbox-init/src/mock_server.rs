//! Mock HTTP server for sandbox testing.
//!
//! Provides:
//! - Mock 1Click API (quote, generate-intent, submit-intent, authenticate, balances)
//! - Delegate action signing endpoint for the mock wallet
//!
//! Runs on port 4000 inside the sandbox container.

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};

const PORT: u16 = 4000;

/// Shared state for the mock server
#[derive(Clone)]
struct MockState {
    submitted_intents: Arc<Mutex<Vec<Value>>>,
    genesis_secret_key: String,
}

pub async fn start(genesis_secret_key: String) {
    let state = MockState {
        submitted_intents: Arc::new(Mutex::new(Vec::new())),
        genesis_secret_key,
    };

    let app = Router::new()
        // Mock 1Click API
        .route("/v0/auth/authenticate", post(auth_authenticate))
        .route("/v0/auth/refresh", post(auth_refresh))
        .route("/v0/quote", post(quote))
        .route("/v0/generate-intent", post(generate_intent))
        .route("/v0/submit-intent", post(submit_intent))
        .route("/v0/account/balances", get(balances))
        .route("/v0/status", get(status))
        // Test helpers
        .route("/_test/submitted-intents", get(get_submitted_intents))
        .route("/_test/reset", post(reset))
        .route("/_test/sign-delegate-action", post(sign_delegate_action))
        .route("/_test/create-session", post(create_test_session))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr = format!("0.0.0.0:{}", PORT);
    tracing::info!("Mock 1Click API + test helpers on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ── Mock 1Click API ─────────────────────────────────────────

async fn auth_authenticate(Json(body): Json<Value>) -> Json<Value> {
    let signer_id = body
        .pointer("/signedData/payload/message")
        .and_then(|m| m.as_str())
        .and_then(|m| serde_json::from_str::<Value>(m).ok())
        .and_then(|v| {
            v.get("signer_id")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
        .unwrap_or_default();

    tracing::info!("Mock auth: {}", signer_id);

    Json(json!({
        "accessToken": format!("mock-access-{}", chrono::Utc::now().timestamp()),
        "refreshToken": format!("mock-refresh-{}", chrono::Utc::now().timestamp()),
        "expiresIn": 3600,
        "refreshExpiresIn": 604800,
    }))
}

async fn auth_refresh() -> Json<Value> {
    Json(json!({
        "accessToken": format!("mock-access-{}", chrono::Utc::now().timestamp()),
        "refreshToken": format!("mock-refresh-{}", chrono::Utc::now().timestamp()),
        "expiresIn": 3600,
        "refreshExpiresIn": 604800,
    }))
}

async fn quote(Json(body): Json<Value>) -> Json<Value> {
    let amount = body
        .get("amount")
        .and_then(|a| a.as_str())
        .unwrap_or("10000000000000000000000");
    let deadline = body
        .get("deadline")
        .and_then(|d| d.as_str())
        .unwrap_or("2099-01-01T00:00:00.000Z");
    let deposit_address = "d32b552aa188face5952516a370bc5a9d91f77a19c48d5b7b16e6c59eb79b08e";

    Json(json!({
        "quote": {
            "amountIn": amount,
            "amountInFormatted": "0.01",
            "amountInUsd": "0.05",
            "minAmountIn": amount,
            "amountOut": amount,
            "amountOutFormatted": "0.01",
            "amountOutUsd": "0.05",
            "minAmountOut": amount,
            "timeEstimate": 10,
            "depositAddress": deposit_address,
            "deadline": deadline,
            "timeWhenInactive": deadline,
        },
        "quoteRequest": body,
        "signature": "mock-signature",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "correlationId": format!("mock-{}", chrono::Utc::now().timestamp_millis()),
    }))
}

async fn generate_intent(Json(body): Json<Value>) -> Json<Value> {
    let signer_id = body
        .get("signerId")
        .and_then(|s| s.as_str())
        .unwrap_or("unknown.near");
    let deposit_address = body
        .get("depositAddress")
        .and_then(|s| s.as_str())
        .unwrap_or("mock");

    let message = json!({
        "deadline": (chrono::Utc::now() + chrono::Duration::hours(24)).to_rfc3339(),
        "intents": [{
            "intent": "transfer",
            "receiver_id": deposit_address,
            "tokens": { "nep141:wrap.near": "10000000000000000000000" },
        }],
        "signer_id": signer_id,
    })
    .to_string();

    // Build a versioned nonce
    let mut nonce = [0u8; 32];
    nonce[0..4].copy_from_slice(&[0x56, 0x28, 0xF6, 0xC6]);
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce[4..]);

    Json(json!({
        "intent": {
            "standard": "nep413",
            "payload": {
                "message": message,
                "nonce": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce),
                "recipient": "intents.near",
            },
        },
        "correlationId": format!("mock-{}", chrono::Utc::now().timestamp_millis()),
    }))
}

async fn submit_intent(State(state): State<MockState>, Json(body): Json<Value>) -> Json<Value> {
    let mut intents = state.submitted_intents.lock().unwrap();
    intents.push(body);
    tracing::info!("Mock submit-intent. Total: {}", intents.len());

    Json(json!({
        "intentHash": format!("mock-intent-hash-{}", chrono::Utc::now().timestamp_millis()),
        "correlationId": format!("mock-{}", chrono::Utc::now().timestamp_millis()),
    }))
}

async fn balances() -> Json<Value> {
    Json(json!({
        "balances": [{
            "available": "20000000000000000000000",
            "source": "private",
            "tokenId": "nep141:wrap.near",
        }],
    }))
}

async fn status() -> Json<Value> {
    Json(json!({ "status": "SUCCESS" }))
}

// ── Test helpers ────────────────────────────────────────────

async fn get_submitted_intents(State(state): State<MockState>) -> Json<Value> {
    let intents = state.submitted_intents.lock().unwrap();
    Json(json!(*intents))
}

async fn reset(State(state): State<MockState>) -> Json<Value> {
    let mut intents = state.submitted_intents.lock().unwrap();
    intents.clear();
    Json(json!({ "ok": true }))
}

/// Create a test auth session by calling the backend's login endpoint.
/// Returns the JWT token for use as a cookie.
async fn create_test_session(Json(body): Json<Value>) -> Json<Value> {
    let account_id = body
        .get("accountId")
        .and_then(|v| v.as_str())
        .unwrap_or("test.near");
    let backend_url = "http://localhost:8080";

    let client = reqwest::Client::new();

    // Step 1: Get challenge nonce
    let challenge_resp = client
        .get(format!("{}/api/auth/challenge", backend_url))
        .send()
        .await
        .ok();

    let nonce = match challenge_resp {
        Some(r) => r
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("nonce").and_then(|n| n.as_str()).map(String::from))
            .unwrap_or_default(),
        None => String::new(),
    };

    // For sandbox testing, we can't do real NEP-413 signing.
    // Instead, insert directly into the DB.
    let jwt_secret = "sandbox-jwt-secret-for-testing";

    // Create JWT using the same algorithm as the backend
    use sha2::Digest;
    let now = chrono::Utc::now();
    let exp = now + chrono::Duration::hours(24);

    let header = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        r#"{"alg":"HS256","typ":"JWT"}"#,
    );
    let payload_json = serde_json::json!({
        "sub": account_id,
        "exp": exp.timestamp(),
        "iat": now.timestamp(),
    });
    let payload = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        payload_json.to_string(),
    );

    let signing_input = format!("{}.{}", header, payload);
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = HmacSha256::new_from_slice(jwt_secret.as_bytes()).unwrap();
    mac.update(signing_input.as_bytes());
    let sig_bytes = mac.finalize().into_bytes();
    let signature =
        base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, sig_bytes);

    let jwt = format!("{}.{}.{}", header, payload, signature);

    // Hash the token
    let mut hasher = sha2::Sha256::new();
    hasher.update(jwt.as_bytes());
    let token_hash = hex::encode(hasher.finalize());

    // Insert user + session via backend's DB
    let db_url = "postgresql://postgres:postgres@localhost:5432/treasury";
    if let Ok(pool) = sqlx::PgPool::connect(db_url).await {
        let _ = sqlx::query(
            "INSERT INTO users (account_id, v1_terms_accepted_at, v2_terms_accepted_at) VALUES ($1, NOW(), NOW()) ON CONFLICT (account_id) DO NOTHING"
        )
        .bind(account_id)
        .execute(&pool)
        .await;

        let _ = sqlx::query(
            "INSERT INTO user_sessions (user_id, token_hash, expires_at) SELECT id, $1, NOW() + INTERVAL '1 day' FROM users WHERE account_id = $2 ON CONFLICT (token_hash) DO NOTHING"
        )
        .bind(&token_hash)
        .bind(account_id)
        .execute(&pool)
        .await;

        pool.close().await;
    }

    tracing::info!("Created test session for {}", account_id);

    Json(json!({
        "token": jwt,
        "accountId": account_id,
        "tokenHash": token_hash,
    }))
}

// ── Delegate action signing ─────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SignDelegateRequest {
    /// The delegate action fields
    sender_id: String,
    receiver_id: String,
    actions: Vec<DelegateActionItem>,
    nonce: u64,
    max_block_height: u64,
    block_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegateActionItem {
    method_name: String,
    args: String, // base64
    gas: String,
    deposit: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignDelegateResponse {
    /// Base64-encoded borsh SignedDelegateAction
    signed_delegate_action: String,
    /// Public key used for signing
    public_key: String,
}

/// Sign a delegate action with the sandbox genesis key.
/// Called by the mock wallet to produce valid signatures for the relay.
async fn sign_delegate_action(
    State(state): State<MockState>,
    Json(req): Json<SignDelegateRequest>,
) -> Result<Json<SignDelegateResponse>, String> {
    use ed25519_dalek::{Signer, SigningKey};

    // Parse the genesis secret key
    let key_str = state
        .genesis_secret_key
        .strip_prefix("ed25519:")
        .unwrap_or(&state.genesis_secret_key);
    let key_bytes = bs58::decode(key_str)
        .into_vec()
        .map_err(|e| format!("bad key: {}", e))?;
    if key_bytes.len() < 32 {
        return Err(format!(
            "key too short: {} bytes, need at least 32",
            key_bytes.len()
        ));
    }
    // ed25519-dalek expects the 32-byte seed (first 32 bytes of the 64-byte expanded key)
    let seed: [u8; 32] = key_bytes[..32].try_into().unwrap();
    let signing_key = SigningKey::from_bytes(&seed);
    let public_key_bytes = signing_key.verifying_key().to_bytes();

    // Build borsh-serialized DelegateAction
    let mut borsh_bytes = Vec::new();

    // sender_id: String (u32 len + utf8)
    borsh_bytes.extend_from_slice(&(req.sender_id.len() as u32).to_le_bytes());
    borsh_bytes.extend_from_slice(req.sender_id.as_bytes());

    // receiver_id: String
    borsh_bytes.extend_from_slice(&(req.receiver_id.len() as u32).to_le_bytes());
    borsh_bytes.extend_from_slice(req.receiver_id.as_bytes());

    // actions: Vec<NonDelegateAction>
    borsh_bytes.extend_from_slice(&(req.actions.len() as u32).to_le_bytes());
    for action in &req.actions {
        // NonDelegateAction enum index: FunctionCall = 2
        borsh_bytes.push(2);
        // method_name: String
        borsh_bytes.extend_from_slice(&(action.method_name.len() as u32).to_le_bytes());
        borsh_bytes.extend_from_slice(action.method_name.as_bytes());
        // args: Vec<u8>
        let args_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &action.args)
                .map_err(|e| format!("bad args base64: {}", e))?;
        borsh_bytes.extend_from_slice(&(args_bytes.len() as u32).to_le_bytes());
        borsh_bytes.extend_from_slice(&args_bytes);
        // gas: u64
        let gas: u64 = action.gas.parse().map_err(|e| format!("bad gas: {}", e))?;
        borsh_bytes.extend_from_slice(&gas.to_le_bytes());
        // deposit: u128
        let deposit: u128 = action
            .deposit
            .parse()
            .map_err(|e| format!("bad deposit: {}", e))?;
        borsh_bytes.extend_from_slice(&deposit.to_le_bytes());
    }

    // nonce: u64
    borsh_bytes.extend_from_slice(&req.nonce.to_le_bytes());

    // max_block_height: u64
    borsh_bytes.extend_from_slice(&req.max_block_height.to_le_bytes());

    // public_key: PublicKey (1 byte key_type=0 + 32 bytes data)
    borsh_bytes.push(0); // ED25519
    borsh_bytes.extend_from_slice(&public_key_bytes);

    // Hash and sign the DelegateAction
    use sha2::Digest;
    // NEP-366 tag: (1 << 30) + 366 = 2147484014
    let nep366_tag = ((1u32 << 30) + 366).to_le_bytes();
    let mut hasher = sha2::Sha256::new();
    hasher.update(&nep366_tag);
    hasher.update(&borsh_bytes);
    let hash = hasher.finalize();

    let signature = signing_key.sign(&hash);

    // Build borsh-serialized SignedDelegateAction
    let mut signed_bytes = Vec::new();
    // delegateAction bytes (already built)
    signed_bytes.extend_from_slice(&borsh_bytes);
    // signature: Signature (1 byte key_type=0 + 64 bytes data)
    signed_bytes.push(0); // ED25519
    signed_bytes.extend_from_slice(&signature.to_bytes());

    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &signed_bytes);

    let pub_key_str = format!("ed25519:{}", bs58::encode(&public_key_bytes).into_string());

    tracing::info!(
        "Signed delegate action: sender={}, receiver={}, {} actions",
        req.sender_id,
        req.receiver_id,
        req.actions.len()
    );

    Ok(Json(SignDelegateResponse {
        signed_delegate_action: encoded,
        public_key: pub_key_str,
    }))
}
