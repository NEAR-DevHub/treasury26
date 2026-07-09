//! Confidential transfer: DAO → personal account (private → private)
//!
//! Both legs are CONFIDENTIAL_INTENTS — fully private transfer.
//! The DAO's confidential balance is debited, and the personal
//! account's confidential balance is credited.
//!
//! Prerequisites:
//! - DAO must have confidential balance (shield first)
//! - PETERSALOMONSEN_DEV and ONECLICK_API_KEY env vars must be set
//!
//! Run with: cargo run --example confidential_transfer

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};
use serde_json::{Value, json};

const ACCOUNT_ID: &str = "petersalomonsendev.near";
const DAO_ID: &str = "petersalomonsendev.sputnik-dao.near";
const RECIPIENT_ID: &str = "petersalomonsendev.near";
const TRANSFER_AMOUNT: &str = "10000000000000000000000"; // 0.01 wNEAR

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

#[allow(dead_code)]
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

async fn create_and_approve_proposal(
    near_secret: &near_api::SecretKey,
    proposal: Value,
    client: &reqwest::Client,
) -> String {
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

    // Fetch the DAO's derived MPC public key from v1.signer
    println!("Fetching MPC public key for {}...", DAO_ID);
    let mpc_public_key = fetch_mpc_public_key(&client, DAO_ID).await;
    println!("MPC public key: {}\n", mpc_public_key);

    // =============================================
    // Step 1: Authenticate DAO with 1Click API
    // =============================================
    println!("=== Step 1: Authenticate DAO via MPC ===\n");

    let salt = fetch_salt(&client).await;
    let auth_deadline = chrono::Utc::now() + chrono::Duration::days(7);
    let auth_nonce = build_nonce(&salt, &auth_deadline);
    let auth_nonce_b64 = BASE64.encode(auth_nonce);

    // Build auth message for the DAO
    let auth_message = json!({
        "deadline": auth_deadline.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "intents": [],
        "signer_id": DAO_ID,
    })
    .to_string();

    // Compute NEP-413 hash for MPC signing
    let nep413_payload = NEP413Payload {
        message: auth_message.clone(),
        nonce: auth_nonce,
        recipient: "intents.near".to_string(),
        callback_url: None,
    };
    const PREFIX: u32 = (1u32 << 31) + 413;
    let mut borsh_bytes = PREFIX.to_le_bytes().to_vec();
    borsh::to_writer(&mut borsh_bytes, &nep413_payload)?;
    use sha2::Digest;
    let auth_hash = sha2::Sha256::digest(&borsh_bytes);
    let auth_hash_hex = hex::encode(auth_hash);

    // Create MPC signing proposal for DAO auth
    let auth_proposal = json!({
        "proposal": {
            "description": "Authenticate DAO for confidential transfer",
            "kind": {
                "FunctionCall": {
                    "receiver_id": "v1.signer",
                    "actions": [{
                        "method_name": "sign",
                        "args": BASE64.encode(json!({
                            "request": {
                                "payload_v2": { "Eddsa": auth_hash_hex },
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

    println!("Creating and approving auth proposal...");
    let auth_result = create_and_approve_proposal(&near_secret, auth_proposal, &client).await;
    let auth_sig_bytes =
        extract_mpc_signature(&auth_result).expect("Failed to extract MPC auth signature");
    let auth_sig_b58 = format!("ed25519:{}", bs58::encode(&auth_sig_bytes).into_string());
    println!("MPC auth signature obtained\n");

    // Authenticate with 1Click using MPC signature
    let auth_resp = client
        .post(format!("{}/v0/auth/authenticate", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .json(&json!({
            "signedData": {
                "standard": "nep413",
                "payload": { "message": auth_message, "nonce": auth_nonce_b64, "recipient": "intents.near" },
                "public_key": mpc_public_key,
                "signature": auth_sig_b58,
            }
        }))
        .send()
        .await?;

    let auth_status = auth_resp.status();
    let auth_data: Value = auth_resp.json().await?;

    if !auth_status.is_success() {
        eprintln!("Auth failed ({}): {}", auth_status, auth_data);
        return Ok(());
    }

    let access_token = auth_data["accessToken"].as_str().unwrap();
    println!("DAO authenticated! Token: {}...\n", &access_token[..30]);

    // =============================================
    // Step 2: Get confidential transfer quote
    // =============================================
    println!("=== Step 2: Get confidential transfer quote ===\n");
    println!(
        "Transferring {} yocto wNEAR from {} → {}\n",
        TRANSFER_AMOUNT, DAO_ID, RECIPIENT_ID
    );

    let quote_deadline = (chrono::Utc::now() + chrono::Duration::hours(24))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    let quote_body = json!({
        "dry": false,
        "swapType": "EXACT_INPUT",
        "slippageTolerance": 100,
        "originAsset": "nep141:wrap.near",
        "depositType": "CONFIDENTIAL_INTENTS",
        "destinationAsset": "nep141:wrap.near",
        "amount": TRANSFER_AMOUNT,
        "refundTo": DAO_ID,
        "refundType": "CONFIDENTIAL_INTENTS",
        "recipient": RECIPIENT_ID,
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
    println!(
        "Quote: {} wNEAR confidential → {} confidential",
        quote_data["quote"]["amountInFormatted"], RECIPIENT_ID
    );
    println!("Deposit address: {}", deposit_address);
    println!(
        "Deadline: {}\n",
        quote_data["quote"]["deadline"].as_str().unwrap()
    );

    // =============================================
    // Step 3: Generate intent
    // =============================================
    println!("=== Step 3: Generate intent ===\n");

    let gen_resp = client
        .post(format!("{}/v0/generate-intent", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
            "type": "swap_transfer",
            "standard": "nep413",
            "depositAddress": deposit_address,
            "signerId": DAO_ID,
        }))
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
    println!("Message: {}\n", intent_message);

    // =============================================
    // Step 4: Create DAO proposal to sign via MPC
    // =============================================
    println!("=== Step 4: Create signing proposal ===\n");

    let intent_nonce: [u8; 32] = BASE64.decode(intent_nonce_b64)?.try_into().unwrap();
    let intent_payload = NEP413Payload {
        message: intent_message.to_string(),
        nonce: intent_nonce,
        recipient: intent_recipient.to_string(),
        callback_url: None,
    };
    let mut intent_bytes = PREFIX.to_le_bytes().to_vec();
    borsh::to_writer(&mut intent_bytes, &intent_payload)?;
    let intent_hash = sha2::Sha256::digest(&intent_bytes);
    let intent_hash_hex = hex::encode(intent_hash);
    println!("NEP-413 hash: {}", intent_hash_hex);

    let proposal = json!({
        "proposal": {
            "description": "Confidential transfer: sign intent via v1.signer",
            "kind": {
                "FunctionCall": {
                    "receiver_id": "v1.signer",
                    "actions": [{
                        "method_name": "sign",
                        "args": BASE64.encode(json!({
                            "request": {
                                "payload_v2": { "Eddsa": intent_hash_hex },
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

    let submit_resp = client
        .post(format!("{}/v0/submit-intent", oneclick_url()))
        .header("content-type", "application/json")
        .header("x-api-key", &api_key)
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&json!({
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
        }))
        .send()
        .await?;

    let submit_status = submit_resp.status();
    let submit_data: Value = submit_resp.json().await?;

    println!(
        "Submit response ({}): {}\n",
        submit_status,
        serde_json::to_string_pretty(&submit_data)?
    );

    // =============================================
    // Step 6: Poll for completion
    // =============================================
    println!("=== Step 6: Poll for completion ===\n");

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
            println!("\n🎉 Confidential transfer complete!");
            println!(
                "{} wNEAR transferred from {} → {}",
                TRANSFER_AMOUNT, DAO_ID, RECIPIENT_ID
            );
            println!("Details: {}", serde_json::to_string_pretty(&status_data)?);
            break;
        }

        if status == "EXPIRED" || status == "FAILED" {
            eprintln!("\nTransfer failed with status: {}", status);
            eprintln!("Details: {}", serde_json::to_string_pretty(&status_data)?);
            break;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
    }

    println!("\n=== Done ===");
    Ok(())
}
