//! Create a sputnik-dao treasury for petersalomonsendev.near
//!
//! Run with: cargo run --example create_dev_treasury

use near_api::{
    NearGas, NearToken, Transaction,
    types::{Action, transaction::actions::FunctionCallAction},
};

const ACCOUNT_ID: &str = "petersalomonsendev.near";
const DAO_FACTORY: &str = "sputnik-dao.near";
const DAO_NAME: &str = "petersalomonsendev";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::from_filename("../.env").ok();
    dotenvy::from_filename(".env").ok();

    let secret_key_str =
        std::env::var("PETERSALOMONSEN_DEV").expect("PETERSALOMONSEN_DEV must be set");
    let near_secret: near_api::SecretKey = secret_key_str.parse()?;

    // DAO creation args matching sputnik-dao factory v3
    let args = serde_json::json!({
        "name": DAO_NAME,
        "args": base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            serde_json::to_string(&serde_json::json!({
                "config": {
                    "name": "petersalomonsendev",
                    "purpose": "Dev treasury for confidential intents PoC",
                    "metadata": ""
                },
                "policy": {
                    "roles": [
                        {
                            "name": "council",
                            "kind": {
                                "Group": [ACCOUNT_ID]
                            },
                            "permissions": [
                                "*:Finalize",
                                "*:AddProposal",
                                "*:VoteApprove",
                                "*:VoteReject",
                                "*:VoteRemove"
                            ],
                            "vote_policy": {}
                        }
                    ],
                    "default_vote_policy": {
                        "weight_kind": "RoleWeight",
                        "quorum": "0",
                        "threshold": [1, 2]
                    },
                    "proposal_bond": "100000000000000000000000",
                    "proposal_period": "604800000000000",
                    "bounty_bond": "1000000000000000000000000",
                    "bounty_forgiveness_period": "86400000000000"
                }
            }))?.as_bytes(),
        )
    });

    println!("Creating DAO: {}.sputnik-dao.near", DAO_NAME);
    println!("Council: [{}]", ACCOUNT_ID);
    println!("Args: {}\n", serde_json::to_string_pretty(&args)?);

    let tx = Transaction::construct(ACCOUNT_ID.parse().unwrap(), DAO_FACTORY.parse().unwrap())
        .add_action(Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "create".to_string(),
            args: serde_json::to_vec(&args)?,
            gas: NearGas::from_tgas(150),
            deposit: NearToken::from_near(5), // 5 NEAR for DAO creation
        })))
        .with_signer(
            near_api::signer::Signer::new(near_api::signer::secret_key::SecretKeySigner::new(
                near_secret,
            ))
            .unwrap(),
        )
        .send_to(&near_api::NetworkConfig::mainnet())
        .await;

    match tx {
        Ok(result) => {
            println!("DAO created successfully!");
            println!("Result: {:?}", result);
        }
        Err(e) => {
            eprintln!("DAO creation failed: {:?}", e);
        }
    }

    Ok(())
}
