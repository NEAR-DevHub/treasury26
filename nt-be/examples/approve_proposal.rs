//! Approve a proposal on the dev treasury.
//! Run with: cargo run --example approve_proposal

use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let proposal_id: u64 = std::env::args().nth(1).unwrap_or("0".to_string()).parse()?;

    let secret: near_api::SecretKey = std::env::var("PETERSALOMONSEN_DEV")?.parse()?;

    println!(
        "Approving proposal {} on petersalomonsendev.sputnik-dao.near...",
        proposal_id
    );

    // Fetch the proposal to get its kind (required by act_proposal)
    let client = reqwest::Client::new();
    let rpc_response = client
        .post("https://rpc.mainnet.near.org")
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "query",
            "params": {
                "request_type": "call_function",
                "finality": "final",
                "account_id": "petersalomonsendev.sputnik-dao.near",
                "method_name": "get_proposal",
                "args_base64": base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    serde_json::json!({"id": proposal_id}).to_string().as_bytes(),
                ),
            }
        }))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_bytes: Vec<u8> = rpc_response["result"]["result"]
        .as_array()
        .expect("result should be array")
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    let proposal: serde_json::Value = serde_json::from_slice(&result_bytes)?;
    let kind = &proposal["kind"];

    println!("Proposal status: {}", proposal["status"]);
    println!("Proposal kind: {}", serde_json::to_string(kind)?);

    let tx = Transaction::construct(
        "petersalomonsendev.near".parse().unwrap(),
        "petersalomonsendev.sputnik-dao.near".parse().unwrap(),
    )
    .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "act_proposal".to_string(),
        args: serde_json::to_vec(&serde_json::json!({
            "id": proposal_id,
            "action": "VoteApprove",
            "proposal": kind,
        }))?,
        gas: NearGas::from_tgas(300),
        deposit: NearToken::from_yoctonear(0),
    })))
    .with_signer(
        near_api::signer::Signer::new(near_api::signer::secret_key::SecretKeySigner::new(secret))
            .unwrap(),
    )
    .send_to(&near_api::NetworkConfig::mainnet())
    .await;

    match tx {
        Ok(r) => {
            println!("Approved! Gas: {:?}", r.total_gas_burnt);
            println!("Result: {:?}", r);
        }
        Err(e) => eprintln!("Failed: {:?}", e),
    }
    Ok(())
}
