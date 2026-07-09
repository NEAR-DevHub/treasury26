//! Check confidential balance for the DAO account
//!
//! Run with: cargo run --example check_confidential_balance

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};

const ACCOUNT_ID: &str = "petersalomonsendev.near";

fn oneclick_url() -> String {
    std::env::var("ONECLICK_API_URL")
        .unwrap_or_else(|_| "https://1click-test.chaindefuser.com".to_string())
}

#[derive(borsh::BorshSerialize)]
struct NEP413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

async fn fetch_salt(client: &reqwest::Client) -> [u8; 4] {
    let resp = client
        .post("https://rpc.mainnet.fastnear.com")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"optimistic",
            "account_id":"intents.near","method_name":"current_salt",
            "args_base64": BASE64.encode("{}"),
        }}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let bytes: Vec<u8> = resp["result"]["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    let hex_str = String::from_utf8(bytes)
        .unwrap()
        .trim_matches('"')
        .to_string();
    hex::decode(&hex_str).unwrap().try_into().unwrap()
}

fn build_nonce(salt: &[u8; 4], deadline: &chrono::DateTime<chrono::Utc>) -> [u8; 32] {
    let deadline_ns = (deadline.timestamp_millis() as u64) * 1_000_000;
    let now_ns = (chrono::Utc::now().timestamp_millis() as u64) * 1_000_000;
    let random_tail: [u8; 7] = rand::random();
    let mut nonce = [0u8; 32];
    nonce[0..4].copy_from_slice(&[0x56, 0x28, 0xF6, 0xC6]);
    nonce[4] = 0;
    nonce[5..9].copy_from_slice(salt);
    nonce[9..17].copy_from_slice(&deadline_ns.to_le_bytes());
    nonce[17..25].copy_from_slice(&now_ns.to_le_bytes());
    nonce[25..32].copy_from_slice(&random_tail);
    nonce
}

fn sign_nep413(
    secret_key_str: &str,
    message: &str,
    nonce: &[u8; 32],
    recipient: &str,
) -> (String, String) {
    let secret_key: near_crypto::SecretKey = secret_key_str.parse().unwrap();
    let public_key = secret_key.public_key();
    let payload = NEP413Payload {
        message: message.to_string(),
        nonce: *nonce,
        recipient: recipient.to_string(),
        callback_url: None,
    };
    const PREFIX: u32 = (1u32 << 31) + 413;
    let mut bytes = PREFIX.to_le_bytes().to_vec();
    borsh::to_writer(&mut bytes, &payload).unwrap();
    use sha2::Digest;
    let hash = sha2::Sha256::digest(&bytes);
    let sig = secret_key.sign(&hash);
    (sig.to_string(), public_key.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let secret_key_str = std::env::var("PETERSALOMONSEN_DEV")?;
    let api_key = std::env::var("ONECLICK_API_KEY")?;
    let client = reqwest::Client::new();

    // Step 1: Authenticate
    println!("=== Authenticating... ===\n");
    let salt = fetch_salt(&client).await;
    let auth_deadline = chrono::Utc::now() + chrono::Duration::minutes(5);
    let auth_nonce = build_nonce(&salt, &auth_deadline);
    let auth_nonce_b64 = BASE64.encode(auth_nonce);

    let auth_message = json!({
        "deadline": auth_deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "intents": [],
        "signer_id": ACCOUNT_ID,
    })
    .to_string();

    let (auth_sig, auth_pub) =
        sign_nep413(&secret_key_str, &auth_message, &auth_nonce, "intents.near");

    let auth_resp = client.post(format!("{}/v0/auth/authenticate", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .json(&json!({
            "signedData": {
                "standard": "nep413",
                "payload": { "message": auth_message, "nonce": auth_nonce_b64, "recipient": "intents.near" },
                "public_key": auth_pub,
                "signature": auth_sig,
            }
        })).send().await?;

    let auth_data: Value = auth_resp.json().await?;
    let access_token = auth_data["accessToken"]
        .as_str()
        .ok_or("Auth failed - no accessToken")?;
    println!("Authenticated as {}\n", ACCOUNT_ID);

    // Step 2: Get confidential balances
    println!("=== Confidential balances ===\n");

    // Get all balances (no token filter)
    let balance_resp = client
        .get(format!("{}/v0/account/balances", oneclick_url()))
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await?;

    let balance_status = balance_resp.status();
    let balance_data: Value = balance_resp.json().await?;

    println!("Status: {}", balance_status);
    println!(
        "Response:\n{}\n",
        serde_json::to_string_pretty(&balance_data)?
    );

    // Also try with specific token
    println!("=== wNEAR balance specifically ===\n");
    let wnear_resp = client
        .get(format!("{}/v0/account/balances", oneclick_url()))
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .query(&[("tokenIds", "nep141:wrap.near")])
        .send()
        .await?;

    let wnear_status = wnear_resp.status();
    let wnear_data: Value = wnear_resp.json().await?;
    println!("Status: {}", wnear_status);
    println!("Response:\n{}", serde_json::to_string_pretty(&wnear_data)?);

    Ok(())
}
