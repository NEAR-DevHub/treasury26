//! Full end-to-end confidential shield: auth → quote → intent → MPC sign → submit
//!
//! Prerequisite: The DAO must already have tokens deposited to intents.near.
//!
//! This script performs a REAL confidential shield of 0.01 wNEAR:
//! 1. Authenticate with 1Click API (test endpoint)
//! 2. Get a real shield quote (INTENTS → CONFIDENTIAL_INTENTS)
//! 3. Generate intent payload
//! 4. Create DAO proposal to sign via v1.signer MPC
//! 5. Approve proposal → get MPC Ed25519 signature
//! 6. Submit signed intent to 1Click API
//! 7. Poll for completion
//!
//! Run with: cargo run --example full_confidential_shield

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};
use serde_json::{Value, json};

const ACCOUNT_ID: &str = "petersalomonsendev.near";
const DAO_ID: &str = "petersalomonsendev.sputnik-dao.near";
// Read from env or default to test API
fn oneclick_url() -> String {
    std::env::var("ONECLICK_API_URL")
        .unwrap_or_else(|_| "https://1click-test.chaindefuser.com".to_string())
}

/// Fetch the DAO's derived MPC public key from v1.signer
async fn fetch_mpc_public_key(client: &reqwest::Client, dao_id: &str) -> String {
    let args = json!({
        "path": dao_id,
        "predecessor": dao_id,
        "domain_id": 1,
    });
    let resp = client
        .post("https://rpc.mainnet.fastnear.com")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"optimistic",
            "account_id":"v1.signer","method_name":"derived_public_key",
            "args_base64": BASE64.encode(args.to_string()),
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
    let key_str = String::from_utf8(bytes).unwrap();
    key_str.trim_matches('"').to_string()
}

const SHIELD_AMOUNT: &str = "10000000000000000000000"; // 0.01 wNEAR

#[derive(borsh::BorshSerialize)]
struct NEP413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

/// Fetch salt from intents.near
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

/// Build versioned nonce
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

/// Sign NEP-413 and return (signature_str, public_key_str)
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

/// Create and approve a DAO proposal, return the execution result debug string
async fn create_and_approve_proposal(
    near_secret: &near_api::SecretKey,
    proposal: Value,
    client: &reqwest::Client,
) -> String {
    // Create proposal
    let _ = Transaction::construct(ACCOUNT_ID.parse().unwrap(), DAO_ID.parse().unwrap())
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

    // Get proposal ID
    let resp = client
        .post("https://rpc.mainnet.fastnear.com")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"final",
            "account_id": DAO_ID, "method_name":"get_last_proposal_id",
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

    // Fetch proposal kind
    let resp = client
        .post("https://rpc.mainnet.fastnear.com")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"query","params":{
            "request_type":"call_function","finality":"final",
            "account_id": DAO_ID, "method_name":"get_proposal",
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

    // Approve
    let result = Transaction::construct(ACCOUNT_ID.parse().unwrap(), DAO_ID.parse().unwrap())
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

/// Extract MPC signature from execution result
fn extract_mpc_signature(result_debug: &str) -> Option<Vec<u8>> {
    let marker = "eyJzY2hlbWUi";
    if let Some(start) = result_debug.find(marker) {
        let rest = &result_debug[start..];
        let end = rest
            .find(|c: char| !c.is_alphanumeric() && c != '+' && c != '/' && c != '=')
            .unwrap_or(rest.len());
        let b64_value = &rest[..end];
        if let Ok(decoded) = BASE64.decode(b64_value)
            && let Ok(sig_json) = serde_json::from_slice::<Value>(&decoded)
            && sig_json.get("scheme").is_some()
        {
            return Some(
                sig_json["signature"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u8)
                    .collect(),
            );
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let secret_key_str = std::env::var("PETERSALOMONSEN_DEV")?;
    let near_secret: near_api::SecretKey = secret_key_str.parse()?;
    let api_key = std::env::var("ONECLICK_API_KEY").expect("ONECLICK_API_KEY must be set");
    let client = reqwest::Client::new();

    println!("Fetching MPC public key for {}...", DAO_ID);
    let mpc_public_key = fetch_mpc_public_key(&client, DAO_ID).await;
    println!("MPC public key: {}\n", mpc_public_key);

    // =============================================
    // Step 1: Authenticate with 1Click API
    // =============================================
    println!("=== Step 1: Authenticate ===\n");

    let salt = fetch_salt(&client).await;
    let auth_deadline = chrono::Utc::now() + chrono::Duration::minutes(5);
    let auth_nonce = build_nonce(&salt, &auth_deadline);
    let auth_nonce_b64 = BASE64.encode(auth_nonce);

    // Auth as personal account (has key on intents.near)
    // The DAO will use MPC key for signing intents, but auth is personal
    let auth_message = json!({
        "deadline": auth_deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "intents": [],
        "signer_id": ACCOUNT_ID,
    })
    .to_string();

    let (auth_sig, auth_pub) =
        sign_nep413(&secret_key_str, &auth_message, &auth_nonce, "intents.near");

    // Note: We auth as the personal account (which has the key on intents.near)
    // The DAO will use MPC key, but for getting the quote we auth with the personal account
    let auth_body = json!({
        "signedData": {
            "standard": "nep413",
            "payload": { "message": auth_message, "nonce": auth_nonce_b64, "recipient": "intents.near" },
            "public_key": auth_pub,
            "signature": auth_sig,
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
        eprintln!("Auth failed ({}): {}", auth_status, auth_data);
        return Ok(());
    }

    let access_token = auth_data["accessToken"].as_str().unwrap();
    println!("Authenticated! Token: {}...\n", &access_token[..30]);

    // =============================================
    // Step 2: Get shield quote
    // =============================================
    println!("=== Step 2: Get shield quote ===\n");

    let quote_deadline = (chrono::Utc::now() + chrono::Duration::hours(24))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let quote_body = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": 100,
        "originAsset": "nep141:wrap.near",
        "depositType": "INTENTS",
        "destinationAsset": "nep141:wrap.near",
        "amount": SHIELD_AMOUNT,
        "refundTo": DAO_ID,
        "refundType": "CONFIDENTIAL_INTENTS",
        "recipient": DAO_ID,
        "recipientType": "CONFIDENTIAL_INTENTS",
        "deadline": quote_deadline,
        "quoteWaitingTimeMs": 5000,
    });

    let quote_resp = client
        .post(format!("{}/v0/quote", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&quote_body)
        .send()
        .await?;

    let quote_status = quote_resp.status();
    let quote_data: Value = quote_resp.json().await?;

    if !quote_status.is_success() {
        eprintln!(
            "Quote failed ({}): {}",
            quote_status,
            serde_json::to_string_pretty(&quote_data)?
        );
        return Ok(());
    }

    let deposit_address = quote_data["quote"]["depositAddress"].as_str().unwrap();
    let quote_deadline_actual = quote_data["quote"]["deadline"].as_str().unwrap();
    println!(
        "Quote: {} wNEAR → confidential",
        quote_data["quote"]["amountInFormatted"]
    );
    println!("Deposit address: {}", deposit_address);
    println!("Deadline: {}\n", quote_deadline_actual);

    // =============================================
    // Step 3: Generate intent
    // =============================================
    println!("=== Step 3: Generate intent ===\n");

    let gen_body = json!({
        "type": "swap_transfer",
        "standard": "nep413",
        "depositAddress": deposit_address,
        "signerId": DAO_ID,
    });

    let gen_resp = client
        .post(format!("{}/v0/generate-intent", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&gen_body)
        .send()
        .await?;

    let gen_status = gen_resp.status();
    let gen_data: Value = gen_resp.json().await?;

    if !gen_status.is_success() {
        eprintln!(
            "Generate intent failed ({}): {}",
            gen_status,
            serde_json::to_string_pretty(&gen_data)?
        );
        return Ok(());
    }

    let intent_message = gen_data["intent"]["payload"]["message"].as_str().unwrap();
    let intent_nonce_b64 = gen_data["intent"]["payload"]["nonce"].as_str().unwrap();
    let intent_recipient = gen_data["intent"]["payload"]["recipient"].as_str().unwrap();

    println!("Intent generated!");
    println!(
        "Message: {}...{}",
        &intent_message[..40],
        &intent_message[intent_message.len() - 30..]
    );
    println!("Nonce: {}\n", intent_nonce_b64);

    // =============================================
    // Step 4: Create DAO proposal to sign via MPC
    // =============================================
    println!("=== Step 4: Create signing proposal ===\n");

    // Compute NEP-413 hash
    let intent_nonce: [u8; 32] = BASE64.decode(intent_nonce_b64)?.try_into().unwrap();
    let nep413_payload = NEP413Payload {
        message: intent_message.to_string(),
        nonce: intent_nonce,
        recipient: intent_recipient.to_string(),
        callback_url: None,
    };
    const PREFIX: u32 = (1u32 << 31) + 413;
    let mut bytes = PREFIX.to_le_bytes().to_vec();
    borsh::to_writer(&mut bytes, &nep413_payload)?;
    use sha2::Digest;
    let hash = sha2::Sha256::digest(&bytes);
    let hash_hex = hex::encode(hash);
    println!("NEP-413 hash: {}", hash_hex);

    let proposal = json!({
        "proposal": {
            "description": "Confidential shield: sign intent via v1.signer",
            "kind": {
                "FunctionCall": {
                    "receiver_id": "v1.signer",
                    "actions": [{
                        "method_name": "sign",
                        "args": BASE64.encode(json!({
                            "request": {
                                "payload_v2": { "Eddsa": hash_hex },
                                "path": DAO_ID,
                                "domain_id": 1,
                            }
                        }).to_string().as_bytes()),
                        "deposit": "1",
                        "gas": "250000000000000",
                    }],
                }
            }
        }
    });

    println!("Creating and approving signing proposal...");
    let result = create_and_approve_proposal(&near_secret, proposal, &client).await;

    let sig_bytes = extract_mpc_signature(&result).expect("Failed to extract MPC signature");
    let sig_b58 = format!("ed25519:{}", bs58::encode(&sig_bytes).into_string());
    println!("MPC signature: {}\n", &sig_b58[..40]);

    // =============================================
    // Step 5: Submit signed intent
    // =============================================
    println!("=== Step 5: Submit signed intent ===\n");

    let submit_body = json!({
        "type": "swap_transfer",
        "signedData": {
            "standard": "nep413",
            "payload": {
                "message": intent_message,
                "nonce": intent_nonce_b64,
                "recipient": intent_recipient,
            },
            "public_key": mpc_public_key,
            "signature": sig_b58,
        }
    });

    let submit_resp = client
        .post(format!("{}/v0/submit-intent", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&submit_body)
        .send()
        .await?;

    let submit_status = submit_resp.status();
    let submit_data: Value = submit_resp.json().await?;

    println!(
        "Submit response ({}): {}\n",
        submit_status,
        serde_json::to_string_pretty(&submit_data)?
    );

    if !submit_status.is_success() {
        eprintln!("Submit failed. The intent may still work if we do the on-chain deposit.");
    }

    // =============================================
    // Step 6: Poll for completion
    // =============================================
    println!("=== Step 6: Poll for completion ===\n");
    println!("Note: The DAO must already have tokens deposited to intents.near.\n");

    for i in 0..30 {
        let status_resp = client
            .get(format!(
                "{}/v0/status?depositAddress={}",
                oneclick_url(),
                deposit_address
            ))
            .header("x-api-key", &api_key)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await?;

        let status_data: Value = status_resp.json().await?;
        let status = status_data
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");

        println!("[{}] Status: {}", i, status);

        if status == "SUCCESS" {
            println!("\n🎉 Confidential shield complete!");
            println!("Details: {}", serde_json::to_string_pretty(&status_data)?);
            break;
        }

        if status == "EXPIRED" || status == "FAILED" {
            eprintln!("\nShield failed with status: {}", status);
            eprintln!("Details: {}", serde_json::to_string_pretty(&status_data)?);
            break;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }

    println!("\n=== Done ===");
    Ok(())
}
