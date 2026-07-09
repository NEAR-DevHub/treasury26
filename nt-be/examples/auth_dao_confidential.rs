//! Authenticate the DAO for confidential intents via MPC signature
//!
//! 1. Build NEP-413 auth message for the DAO
//! 2. Create v1.signer proposal to sign it
//! 3. Approve → get MPC Ed25519 signature
//! 4. Send to /v0/auth/authenticate
//! 5. Print JWT tokens (copy to .env)
//!
//! Run with: cargo run --example auth_dao_confidential -- <account_id> <dao_id> [secret_key_env_var]
//!
//! Example: cargo run --example auth_dao_confidential -- alice.near my-dao.sputnik-dao.near MY_SECRET_KEY

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};
use serde_json::{Value, json};

const V1_SIGNER_CONTRACT_ID: &str = "v1.signer";

async fn fetch_mpc_public_key(dao_id: &str) -> Result<String, Box<dyn std::error::Error>> {
    let args = serde_json::json!({
        "path": dao_id,
        "predecessor": dao_id,
        "domain_id": 1,
    });

    let result = near_api::Contract(V1_SIGNER_CONTRACT_ID.parse().unwrap())
        .call_function("derived_public_key", args)
        .read_only::<String>()
        .fetch_from(&near_api::NetworkConfig::mainnet())
        .await?;

    Ok(result.data)
}

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
        .post("https://near.lava.build")
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

async fn create_and_approve_proposal(
    account_id: &str,
    dao_id: &str,
    near_secret: &near_api::SecretKey,
    proposal: Value,
    client: &reqwest::Client,
) -> String {
    let _ = Transaction::construct(account_id.parse().unwrap(), dao_id.parse().unwrap())
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "add_proposal".to_string(),
            args: serde_json::to_vec(&proposal).unwrap(),
            gas: NearGas::from_tgas(100),
            deposit: NearToken::from_yoctonear(0),
        })))
        .with_signer(
            near_api::signer::Signer::new(near_api::signer::secret_key::SecretKeySigner::new(
                near_secret.clone(),
            ))
            .unwrap(),
        )
        .send_to(&near_api::NetworkConfig::mainnet())
        .await
        .unwrap();

    let resp = client
        .post("https://near.lava.build")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"final",
            "account_id": dao_id, "method_name":"get_last_proposal_id",
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
    let proposal_id: u64 = String::from_utf8(bytes).unwrap().parse().unwrap();
    let proposal_id = proposal_id - 1;
    println!("  Proposal ID: {}", proposal_id);

    let resp = client
        .post("https://near.lava.build")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"final",
            "account_id": dao_id, "method_name":"get_proposal",
            "args_base64": BASE64.encode(json!({"id": proposal_id}).to_string()),
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
    let proposal_data: Value = serde_json::from_slice(&bytes).unwrap();
    let kind = &proposal_data["kind"];

    let result = Transaction::construct(account_id.parse().unwrap(), dao_id.parse().unwrap())
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "act_proposal".to_string(),
            args: serde_json::to_vec(&json!({
                "id": proposal_id, "action": "VoteApprove", "proposal": kind,
            }))
            .unwrap(),
            gas: NearGas::from_tgas(300),
            deposit: NearToken::from_yoctonear(0),
        })))
        .with_signer(
            near_api::signer::Signer::new(near_api::signer::secret_key::SecretKeySigner::new(
                near_secret.clone(),
            ))
            .unwrap(),
        )
        .send_to(&near_api::NetworkConfig::mainnet())
        .await
        .unwrap();

    format!("{:?}", result)
}

fn extract_mpc_signature(result_debug: &str) -> Option<Vec<u8>> {
    let marker = "eyJzY2hlbWUi";
    if let Some(start) = result_debug.find(marker) {
        let rest = &result_debug[start..];
        let end = rest
            .find(|c: char| !c.is_alphanumeric() && c != '+' && c != '/' && c != '=')
            .unwrap_or(rest.len());
        let b64_value = &rest[..end];
        if let Ok(decoded) = BASE64.decode(b64_value) {
            let sig_json: Value = serde_json::from_slice(&decoded).ok()?;
            eprintln!(
                "MPC response JSON: {}",
                serde_json::to_string_pretty(&sig_json).unwrap_or_default()
            );
            if let Some(sig_arr) = sig_json["signature"].as_array() {
                return Some(
                    sig_arr
                        .iter()
                        .map(|v| v.as_u64().unwrap_or(0) as u8)
                        .collect(),
                );
            }
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "Usage: {} <account_id> <dao_id> [secret_key_env_var]",
            args[0]
        );
        eprintln!("  secret_key_env_var defaults to NEAR_SECRET_KEY");
        std::process::exit(1);
    }
    let account_id = &args[1];
    let dao_id = &args[2];
    let secret_key_env = args.get(3).map(|s| s.as_str()).unwrap_or("NEAR_SECRET_KEY");

    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let secret_key_str = std::env::var(secret_key_env)
        .map_err(|_| format!("env var '{}' not set", secret_key_env))?;
    let near_secret: near_api::SecretKey = secret_key_str.parse()?;
    let api_key = std::env::var("ONECLICK_API_KEY")?;
    let client = reqwest::Client::new();

    // Step 1: Build NEP-413 auth message for the DAO
    println!("=== Step 1: Build auth message for DAO ===\n");

    let salt = fetch_salt(&client).await;
    let auth_deadline = chrono::Utc::now() + chrono::Duration::days(7); // Long-lived for auth
    let auth_nonce = build_nonce(&salt, &auth_deadline);
    let auth_nonce_b64 = BASE64.encode(auth_nonce);
    let deadline = auth_deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let expires_in: u32 = 36500 * 24 * 3600;
    let auth_message = json!({
        "deadline": deadline,
        "intents": [],
        "signer_id": dao_id,
        "external_app_data": {
            "configs": [{
                "type": "auth",
                "expires_in": expires_in,
            }]
        }
    })
    .to_string();

    // Step 2: Hash the NEP-413 payload (same as what v1.signer will sign)
    println!("\n=== Step 2: Create signing proposal via v1.signer ===\n");

    let payload = NEP413Payload {
        message: auth_message.clone(),
        nonce: auth_nonce,
        recipient: "intents.near".to_string(),
        callback_url: None,
    };
    const PREFIX: u32 = (1u32 << 31) + 413;
    let mut bytes = PREFIX.to_le_bytes().to_vec();
    borsh::to_writer(&mut bytes, &payload).unwrap();
    use sha2::Digest;
    let hash = sha2::Sha256::digest(&bytes);
    let hash_hex = hex::encode(hash);
    println!("NEP-413 hash: {}", hash_hex);

    // Build v1.signer sign proposal
    let sign_args = json!({
        "request": {
            "path": dao_id,
            "payload_v2": {
                "Eddsa": hash_hex,
            },
            "domain_id": 1,
        }
    });

    let proposal = json!({
        "proposal": {
            "description": "Auth for confidential intents",
            "kind": {
                "FunctionCall": {
                    "receiver_id": "v1.signer",
                    "actions": [{
                        "method_name": "sign",
                        "args": BASE64.encode(sign_args.to_string()),
                        "deposit": "1",
                        "gas": "250000000000000"
                    }]
                }
            }
        }
    });

    println!("Creating and approving signing proposal...");
    let result =
        create_and_approve_proposal(account_id, dao_id, &near_secret, proposal, &client).await;

    // Write full result to file for debugging
    std::fs::write("examples/fixtures/mpc_auth_result.txt", &result).ok();

    let sig_bytes = match extract_mpc_signature(&result) {
        Some(bytes) => bytes,
        None => {
            // Try to find any base64 in receipts
            eprintln!(
                "Failed to extract MPC signature. Full result written to mpc_auth_result.txt"
            );
            eprintln!("Result length: {} chars", result.len());
            // Print last 500 chars which might have the return value
            let start = result.len().saturating_sub(500);
            eprintln!("...{}", &result[start..]);
            return Ok(());
        }
    };
    let sig_str = format!("ed25519:{}", bs58::encode(&sig_bytes).into_string());
    println!("MPC signature: {}...", &sig_str[..50]);

    // Step 3: Authenticate the DAO with the MPC signature
    println!("\n=== Step 3: Authenticate DAO ===\n");

    let mpc_public_key = fetch_mpc_public_key(dao_id).await?;
    println!("Fetched MPC public key: {}", mpc_public_key);

    let auth_body = json!({
        "signedData": {
            "standard": "nep413",
            "payload": {
                "message": auth_message,
                "nonce": auth_nonce_b64,
                "recipient": "intents.near"
            },
            "public_key": mpc_public_key,
            "signature": sig_str,
        }
    });

    let auth_resp = client
        .post(format!("{}/v0/auth/authenticate", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .json(&auth_body)
        .send()
        .await?;

    let auth_status = auth_resp.status();
    let auth_data: Value = auth_resp.json().await?;

    if !auth_status.is_success() {
        eprintln!(
            "Auth failed ({}): {}",
            auth_status,
            serde_json::to_string_pretty(&auth_data)?
        );
        return Ok(());
    }

    let access_token = auth_data["accessToken"].as_str().unwrap();
    let refresh_token = auth_data["refreshToken"].as_str().unwrap();
    println!("DAO authenticated!");
    println!("\nAdd these to your .env:");
    println!("DAO_CONFIDENTIAL_ACCESS_TOKEN={}", access_token);
    println!("DAO_CONFIDENTIAL_REFRESH_TOKEN={}", refresh_token);

    // Step 4: Check DAO's confidential balance
    println!("\n=== Step 4: DAO confidential balance ===\n");

    let balance_resp = client
        .get(format!("{}/v0/account/balances", oneclick_url()))
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await?;

    let balance_data: Value = balance_resp.json().await?;
    println!("{}", serde_json::to_string_pretty(&balance_data)?);

    Ok(())
}
