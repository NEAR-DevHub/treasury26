//! NEAR Sandbox Initializer for Treasury Test Environment
//!
//! This binary initializes a NEAR sandbox environment for testing:
//! - Downloads and starts near-sandbox
//! - Deploys contracts (bulk-payment, sputnik-dao, wrap.near, intents.near)
//! - Sets up test accounts

use anyhow::{Context, Result};
use near_api::{AccountId, Contract, NearToken, Signer};
use near_gas::NearGas;
use near_sandbox::Sandbox;
use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{info, warn};

/// Genesis account credentials (well-known sandbox test key)
const GENESIS_ACCOUNT_ID: &str = "test.near";
const GENESIS_PRIVATE_KEY: &str =
    "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB";

/// Contract account IDs
const BULK_PAYMENT_CONTRACT_ID: &str = "bulk-payment.near";
const DAO_FACTORY_ID: &str = "sputnik-dao.near";
const WRAP_NEAR_ID: &str = "wrap.near";
const INTENTS_ID: &str = "intents.near";

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("sandbox_init=info".parse().unwrap()),
        )
        .init();

    let sandbox_home = env::var("SANDBOX_HOME").unwrap_or_else(|_| "/data/sandbox".to_string());
    let contract_dir = env::var("CONTRACT_DIR").unwrap_or_else(|_| "/app/contracts".to_string());
    let rpc_port: u16 = env::var("SANDBOX_RPC_PORT")
        .unwrap_or_else(|_| "3031".to_string())
        .parse()
        .unwrap_or(3031);

    info!("Starting NEAR sandbox initialization");
    info!("Sandbox home: {}", sandbox_home);
    info!("Contract directory: {}", contract_dir);
    info!("RPC port: {}", rpc_port);

    // Check if sandbox is already initialized
    let sandbox_initialized = Path::new(&sandbox_home).join("data").exists();

    // Start sandbox
    let sandbox = start_sandbox(&sandbox_home, rpc_port).await?;

    // Wait for sandbox to be ready
    wait_for_sandbox(rpc_port).await?;

    if !sandbox_initialized {
        info!("First run - deploying contracts");

        let network = near_api::NetworkConfig::new_custom(format!("http://localhost:{}", rpc_port))
            .with_archival(true);

        // Get genesis signer
        let genesis_signer = get_genesis_signer()?;
        let genesis_account: AccountId = GENESIS_ACCOUNT_ID.parse().unwrap();

        // Deploy bulk payment contract
        deploy_bulk_payment_contract(&network, &genesis_signer, &contract_dir).await?;

        // Import contracts from mainnet (or use local copies)
        import_or_deploy_contracts(&network, &genesis_signer, &contract_dir).await?;

        // Deploy Sputnik DAO factory
        deploy_dao_factory(&network, &genesis_signer, &contract_dir).await?;

        info!("Contract deployment complete!");
    } else {
        info!("Sandbox already initialized, skipping contract deployment");
    }

    info!("Sandbox ready on port {}", rpc_port);

    // Keep the sandbox running
    sandbox.await_termination().await?;

    Ok(())
}

async fn start_sandbox(home: &str, port: u16) -> Result<Sandbox> {
    info!("Starting NEAR sandbox");

    let sandbox = Sandbox::new()
        .home(home)
        .rpc_port(port)
        .archival(true)
        .start()
        .await
        .context("Failed to start sandbox")?;

    Ok(sandbox)
}

async fn wait_for_sandbox(port: u16) -> Result<()> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:{}/status", port);

    info!("Waiting for sandbox to be ready...");

    for i in 0..60 {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                info!("Sandbox is ready!");
                return Ok(());
            }
            _ => {
                if i % 10 == 0 {
                    info!("Still waiting for sandbox... ({}/60)", i);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }

    anyhow::bail!("Timeout waiting for sandbox to start")
}

fn get_genesis_signer() -> Result<Signer> {
    let signer = Signer::from_secret_str(GENESIS_PRIVATE_KEY)?;
    Ok(signer)
}

async fn deploy_bulk_payment_contract(
    network: &near_api::NetworkConfig,
    genesis_signer: &Signer,
    contract_dir: &str,
) -> Result<()> {
    let wasm_path = Path::new(contract_dir).join("bulk_payment.wasm");
    let wasm = fs::read(&wasm_path).context("Failed to read bulk payment contract WASM")?;

    info!(
        "Deploying bulk payment contract to {}",
        BULK_PAYMENT_CONTRACT_ID
    );

    let contract_id: AccountId = BULK_PAYMENT_CONTRACT_ID.parse().unwrap();
    let genesis_id: AccountId = GENESIS_ACCOUNT_ID.parse().unwrap();

    // Create account for contract
    near_api::Account(genesis_id.clone())
        .create_account(contract_id.clone())
        .fund_myself(NearToken::from_near(100))
        .public_key(genesis_signer.public_key())
        .new_keypair()
        .transaction()
        .with_signer_account(genesis_id.clone())
        .with_signer(genesis_signer.clone())
        .send_to(network)
        .await
        .context("Failed to create bulk payment account")?;

    // Deploy contract
    Contract(contract_id.clone())
        .deploy(wasm)
        .without_init_call()
        .transaction()
        .with_signer_account(contract_id.clone())
        .with_signer(genesis_signer.clone())
        .send_to(network)
        .await
        .context("Failed to deploy bulk payment contract")?;

    // Initialize contract
    Contract(contract_id.clone())
        .call_function("new", json!({}))
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer_account(contract_id.clone())
        .with_signer(genesis_signer.clone())
        .send_to(network)
        .await
        .context("Failed to initialize bulk payment contract")?;

    info!("Bulk payment contract deployed successfully");
    Ok(())
}

async fn import_or_deploy_contracts(
    network: &near_api::NetworkConfig,
    genesis_signer: &Signer,
    contract_dir: &str,
) -> Result<()> {
    let genesis_id: AccountId = GENESIS_ACCOUNT_ID.parse().unwrap();

    // Deploy wrap.near
    let wrap_wasm_path = Path::new(contract_dir).join("wrap_near.wasm");
    if wrap_wasm_path.exists() {
        info!("Deploying wrap.near from local file");
        let wasm = fs::read(&wrap_wasm_path)?;
        let wrap_id: AccountId = WRAP_NEAR_ID.parse().unwrap();

        near_api::Account(genesis_id.clone())
            .create_account(wrap_id.clone())
            .fund_myself(NearToken::from_near(100))
            .public_key(genesis_signer.public_key())
            .new_keypair()
            .transaction()
            .with_signer_account(genesis_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        Contract(wrap_id.clone())
            .deploy(wasm)
            .without_init_call()
            .transaction()
            .with_signer_account(wrap_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        info!("wrap.near deployed");
    } else {
        warn!("wrap_near.wasm not found, skipping wrap.near deployment");
    }

    // Deploy intents.near
    let intents_wasm_path = Path::new(contract_dir).join("intents.wasm");
    if intents_wasm_path.exists() {
        info!("Deploying intents.near from local file");
        let wasm = fs::read(&intents_wasm_path)?;
        let intents_id: AccountId = INTENTS_ID.parse().unwrap();

        near_api::Account(genesis_id.clone())
            .create_account(intents_id.clone())
            .fund_myself(NearToken::from_near(100))
            .public_key(genesis_signer.public_key())
            .new_keypair()
            .transaction()
            .with_signer_account(genesis_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        Contract(intents_id.clone())
            .deploy(wasm)
            .without_init_call()
            .transaction()
            .with_signer_account(intents_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        info!("intents.near deployed");
    } else {
        warn!("intents.wasm not found, skipping intents.near deployment");
    }

    Ok(())
}

async fn deploy_dao_factory(
    network: &near_api::NetworkConfig,
    genesis_signer: &Signer,
    contract_dir: &str,
) -> Result<()> {
    let genesis_id: AccountId = GENESIS_ACCOUNT_ID.parse().unwrap();

    let dao_factory_wasm_path = Path::new(contract_dir).join("sputnik_dao_factory.wasm");
    if dao_factory_wasm_path.exists() {
        info!("Deploying Sputnik DAO factory");
        let wasm = fs::read(&dao_factory_wasm_path)?;
        let dao_factory_id: AccountId = DAO_FACTORY_ID.parse().unwrap();

        near_api::Account(genesis_id.clone())
            .create_account(dao_factory_id.clone())
            .fund_myself(NearToken::from_near(100))
            .public_key(genesis_signer.public_key())
            .new_keypair()
            .transaction()
            .with_signer_account(genesis_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        Contract(dao_factory_id.clone())
            .deploy(wasm)
            .without_init_call()
            .transaction()
            .with_signer_account(dao_factory_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        // Initialize the factory
        Contract(dao_factory_id.clone())
            .call_function("new", json!({}))
            .transaction()
            .gas(NearGas::from_tgas(30))
            .with_signer_account(dao_factory_id.clone())
            .with_signer(genesis_signer.clone())
            .send_to(network)
            .await
            .ok();

        info!("Sputnik DAO factory deployed");
    } else {
        warn!("sputnik_dao_factory.wasm not found, skipping DAO factory deployment");
    }

    Ok(())
}
