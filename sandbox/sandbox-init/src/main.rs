//! NEAR Sandbox Initializer for Treasury Test Environment
//!
//! This binary starts a NEAR sandbox with persistent storage, deploys the required contracts,
//! and keeps the sandbox running for testing.
//!
//! Supports persistent mode where blockchain state survives container restarts.

use anyhow::{Context, Result};
use base64::Engine;
use near_api::types::AccessKeyPermission;
use near_api::{AccountId, NearToken, NetworkConfig, PublicKey, Signer};
use near_gas::NearGas;
use near_sandbox::GenesisAccount;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::{Child, Command};
use tracing::{error, info, warn};

/// Default sandbox version to use
const SANDBOX_VERSION: &str = "2.9.0";

/// Get the genesis signer for the sandbox
fn get_genesis_signer() -> Arc<Signer> {
    let genesis_account = GenesisAccount::default();
    Signer::new(Signer::from_secret_key(
        genesis_account.private_key.parse().unwrap(),
    ))
    .unwrap()
}

/// Download the sandbox binary using the SANDBOX_ARTIFACT_URL if set
async fn ensure_sandbox_binary() -> Result<PathBuf> {
    // Check if we have a custom artifact URL (for ARM64 support)
    let artifact_url = std::env::var("SANDBOX_ARTIFACT_URL").ok();

    let home = dirs_next::home_dir().context("Could not find home directory")?;
    let bin_dir = home
        .join(".near")
        .join(format!("near-sandbox-{}", SANDBOX_VERSION));
    let bin_path = bin_dir.join("near-sandbox");

    if bin_path.exists() {
        info!("Sandbox binary already exists at {:?}", bin_path);
        return Ok(bin_path);
    }

    std::fs::create_dir_all(&bin_dir)?;

    let url = artifact_url.unwrap_or_else(|| {
        format!(
            "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/{}/near-sandbox.tar.gz",
            SANDBOX_VERSION
        )
    });

    info!("Downloading sandbox binary from {}", url);

    // Download and extract
    let response = reqwest::get(&url).await?;
    let bytes = response.bytes().await?;

    // Extract tar.gz to a temp location first
    let temp_dir = bin_dir.join("temp_extract");
    std::fs::create_dir_all(&temp_dir)?;

    let decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&temp_dir)?;

    // Find the near-sandbox binary in the extracted contents
    // It might be at temp_extract/near-sandbox or temp_extract/Linux-*/near-sandbox
    let mut found_binary = None;
    for entry in std::fs::read_dir(&temp_dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_file() && path.file_name().map(|n| n == "near-sandbox").unwrap_or(false) {
            found_binary = Some(path);
            break;
        } else if path.is_dir() {
            // Check inside subdirectory
            let nested_binary = path.join("near-sandbox");
            if nested_binary.exists() {
                found_binary = Some(nested_binary);
                break;
            }
        }
    }

    let extracted_binary =
        found_binary.context("Could not find near-sandbox binary in archive")?;

    // Move to final location
    std::fs::rename(&extracted_binary, &bin_path)?;

    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755))?;
    }

    info!("Sandbox binary installed at {:?}", bin_path);
    Ok(bin_path)
}

/// Initialize sandbox home directory if not already initialized
async fn init_sandbox_home(bin_path: &Path, home_dir: &Path) -> Result<()> {
    let genesis_path = home_dir.join("genesis.json");

    if genesis_path.exists() {
        info!("Sandbox home already initialized at {:?}", home_dir);
        return Ok(());
    }

    info!("Initializing sandbox home directory at {:?}", home_dir);
    std::fs::create_dir_all(home_dir)?;

    let output = Command::new(bin_path)
        .args(["--home", home_dir.to_str().unwrap(), "init", "--fast"])
        .output()
        .await
        .context("Failed to run sandbox init")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("Sandbox init failed: {}", stderr);
    }

    info!("Sandbox home initialized successfully");
    Ok(())
}

/// Configure genesis.json with additional accounts
fn configure_genesis(home_dir: &Path, additional_accounts: &[GenesisAccount]) -> Result<()> {
    let genesis_path = home_dir.join("genesis.json");
    let content = std::fs::read_to_string(&genesis_path)?;
    let mut genesis: serde_json::Value = serde_json::from_str(&content)?;

    // Get our genesis public key
    let genesis_account = GenesisAccount::default();
    let our_public_key = &genesis_account.public_key;

    // Calculate additional supply from new accounts
    let mut additional_supply: u128 = 0;
    for account in additional_accounts {
        additional_supply += account.balance.as_yoctonear();
    }

    // Update total supply
    if let Some(total_supply) = genesis.get_mut("total_supply") {
        let current_supply: u128 = total_supply.as_str().unwrap_or("0").parse().unwrap_or(0);
        let new_supply = current_supply + additional_supply;
        *total_supply = serde_json::json!(new_supply.to_string());
        info!(
            "Updated total supply from {} to {}",
            current_supply, new_supply
        );
    }

    // Update existing access keys for near and test.near to use our genesis key
    if let Some(records) = genesis.get_mut("records").and_then(|r| r.as_array_mut()) {
        for record in records.iter_mut() {
            if let Some(access_key) = record.get_mut("AccessKey") {
                let should_update = {
                    let account_id = access_key
                        .get("account_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    account_id == "near" || account_id == "test.near"
                };
                if should_update {
                    let account_id = access_key
                        .get("account_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    access_key["public_key"] = serde_json::json!(our_public_key);
                    info!(
                        "Updated access key for {} to use genesis signer",
                        account_id
                    );
                }
            }
        }

        // Add additional accounts to genesis
        for account in additional_accounts {
            // Add account record
            records.push(serde_json::json!({
                "Account": {
                    "account_id": account.account_id.to_string(),
                    "account": {
                        "amount": account.balance.as_yoctonear().to_string(),
                        "locked": "0",
                        "code_hash": "11111111111111111111111111111111",
                        "storage_usage": 0,
                        "version": "V1"
                    }
                }
            }));

            // Add access key record
            records.push(serde_json::json!({
                "AccessKey": {
                    "account_id": account.account_id.to_string(),
                    "public_key": account.public_key,
                    "access_key": {
                        "nonce": 0,
                        "permission": "FullAccess"
                    }
                }
            }));
        }
    }

    std::fs::write(&genesis_path, serde_json::to_string_pretty(&genesis)?)?;
    info!(
        "Genesis configured with {} additional accounts",
        additional_accounts.len()
    );
    Ok(())
}

/// Start the sandbox process
async fn start_sandbox(
    bin_path: &Path,
    home_dir: &Path,
    rpc_port: u16,
    net_port: u16,
) -> Result<Child> {
    let rpc_addr = format!("127.0.0.1:{}", rpc_port);
    let net_addr = format!("127.0.0.1:{}", net_port);

    info!(
        "Starting sandbox in archival mode with RPC at {} and network at {}",
        rpc_addr, net_addr
    );

    let child = Command::new(bin_path)
        .args([
            "--home",
            home_dir.to_str().unwrap(),
            "run",
            "--archive",
            "--rpc-addr",
            &rpc_addr,
            "--network-addr",
            &net_addr,
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("Failed to start sandbox")?;

    Ok(child)
}

/// Wait for sandbox to be ready
async fn wait_for_sandbox(rpc_url: &str) -> Result<()> {
    let status_url = format!("{}/status", rpc_url);
    let client = reqwest::Client::new();

    for i in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;

        match client.get(&status_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                info!("Sandbox is ready after {} attempts", i + 1);
                return Ok(());
            }
            _ => {
                if i % 10 == 0 {
                    info!("Waiting for sandbox to be ready... (attempt {})", i + 1);
                }
            }
        }
    }

    anyhow::bail!("Sandbox failed to start within 30 seconds")
}

/// Create a new account with the given balance
async fn create_account(
    new_account_id: &AccountId,
    parent_account_id: &AccountId,
    balance: NearToken,
    network_config: &NetworkConfig,
) -> Result<Arc<Signer>> {
    info!(
        "Creating account: {} (funded by {})",
        new_account_id, parent_account_id
    );

    let genesis_account = GenesisAccount::default();

    near_api::Account::create_account(new_account_id.clone())
        .fund_myself(parent_account_id.clone(), balance)
        .public_key(
            genesis_account
                .public_key
                .parse::<near_api::PublicKey>()
                .unwrap(),
        )
        .unwrap()
        .with_signer(get_genesis_signer())
        .send_to(network_config)
        .await
        .context(format!("Failed to create account {}", new_account_id))?
        .assert_success();

    Ok(get_genesis_signer())
}

/// Import a contract from mainnet to the sandbox
async fn import_contract(
    network_config: &NetworkConfig,
    account_id: &AccountId,
    mainnet_account_id: &str,
) -> Result<()> {
    info!(
        "Importing contract {} from mainnet as {}",
        mainnet_account_id, account_id
    );

    // Configure mainnet connection
    let mainnet_config = NetworkConfig::mainnet();

    // Fetch contract code from mainnet
    let mainnet_rpc_url = mainnet_config.rpc_endpoints[0].url.as_str();
    let client = reqwest::Client::new();

    // View code
    let code_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "dontcare",
        "method": "query",
        "params": {
            "request_type": "view_code",
            "finality": "final",
            "account_id": mainnet_account_id
        }
    });

    let code_response: serde_json::Value = client
        .post(mainnet_rpc_url)
        .json(&code_request)
        .send()
        .await
        .context("Failed to fetch contract code from mainnet")?
        .json()
        .await
        .context("Failed to parse mainnet response")?;

    let contract_code_base64 = code_response["result"]["code_base64"]
        .as_str()
        .context("Failed to get code_base64 from response")?;
    let contract_code = base64::engine::general_purpose::STANDARD
        .decode(contract_code_base64)
        .context("Failed to decode contract code")?;

    info!(
        "Fetched {} bytes of contract code for {}",
        contract_code.len(),
        mainnet_account_id
    );

    // Use genesis signer for the pre-created account
    let account_signer = get_genesis_signer();

    // Deploy the contract code to the sandbox account
    // For wrap.near, we need to initialize it since it's a fresh deployment
    if mainnet_account_id == "wrap.near" {
        near_api::Contract::deploy(account_id.clone())
            .use_code(contract_code)
            .with_init_call("new", serde_json::json!({}))
            .unwrap()
            .with_signer(account_signer.clone())
            .send_to(network_config)
            .await
            .context(format!("Failed to deploy {} with init", account_id))?
            .assert_success();
    } else if mainnet_account_id == "intents.near" {
        // intents.near requires special initialization with config
        near_api::Contract::deploy(account_id.clone())
            .use_code(contract_code)
            .with_init_call(
                "new",
                serde_json::json!({
                    "config": {
                        "wnear_id": "wrap.near",
                        "fees": {
                            "fee": 100,
                            "fee_collector": account_id.to_string()
                        },
                        "roles": {
                            "super_admins": [account_id.to_string()],
                            "admins": {},
                            "grantees": {}
                        }
                    }
                }),
            )
            .unwrap()
            .with_signer(account_signer.clone())
            .send_to(network_config)
            .await
            .context(format!("Failed to deploy {} with init", account_id))?
            .assert_success();
    } else {
        // For other contracts, skip initialization (already initialized on mainnet)
        near_api::Contract::deploy(account_id.clone())
            .use_code(contract_code)
            .without_init_call()
            .with_signer(account_signer.clone())
            .send_to(network_config)
            .await
            .context(format!("Failed to deploy {}", account_id))?
            .assert_success();
    }

    info!("Successfully deployed contract to {}", account_id);
    Ok(())
}

/// Deploy the bulk payment contract from a WASM file
async fn deploy_bulk_payment_contract(
    network_config: &NetworkConfig,
    contract_id: &AccountId,
    wasm_path: &str,
) -> Result<()> {
    info!("Deploying bulk payment contract to {}", contract_id);

    let contract_code =
        std::fs::read(wasm_path).context(format!("Failed to read contract WASM from {}", wasm_path))?;

    info!(
        "Read {} bytes of bulk payment contract",
        contract_code.len()
    );

    let contract_signer = get_genesis_signer();

    near_api::Contract::deploy(contract_id.clone())
        .use_code(contract_code)
        .with_init_call("new", ())
        .unwrap()
        .with_signer(contract_signer.clone())
        .send_to(network_config)
        .await
        .context("Failed to deploy bulk payment contract")?
        .assert_success();

    info!(
        "Successfully deployed bulk payment contract to {}",
        contract_id
    );

    // Add a full access key for the API signer (needs to send multi-action transactions)
    info!(
        "Adding full access key to {} for API signer",
        contract_id
    );

    // Dedicated API access key (hardcoded for sandbox)
    let api_public_key: PublicKey =
        "ed25519:C72KRM91LgqMmbKVspQAF9j5dgGGaxYPT5rnnXtLXmsN"
            .parse()
            .expect("Failed to parse API public key");

    near_api::Account(contract_id.clone())
        .add_key(AccessKeyPermission::FullAccess, api_public_key)
        .with_signer(contract_signer)
        .send_to(network_config)
        .await
        .context("Failed to add full access key")?
        .assert_success();

    info!("Successfully added full access key to {}", contract_id);
    Ok(())
}

/// Deploy a DAO contract from a WASM file
async fn deploy_dao_contract(
    network_config: &NetworkConfig,
    contract_id: &AccountId,
    wasm_path: &str,
) -> Result<()> {
    info!("Deploying DAO contract to {}", contract_id);

    let contract_code =
        std::fs::read(wasm_path).context(format!("Failed to read DAO WASM from {}", wasm_path))?;

    info!("Read {} bytes of DAO contract", contract_code.len());

    let contract_signer = get_genesis_signer();

    let genesis_account = GenesisAccount::default();

    // Initialize DAO with a simple policy
    let policy = serde_json::json!({
        "roles": [{
            "name": "council",
            "kind": { "Group": [genesis_account.account_id.to_string()] },
            "permissions": ["*:*"],
            "vote_policy": {}
        }],
        "default_vote_policy": {
            "weight_kind": "RoleWeight",
            "quorum": "0",
            "threshold": [1, 2]
        },
        "proposal_bond": "100000000000000000000000",
        "proposal_period": "604800000000000",
        "bounty_bond": "100000000000000000000000",
        "bounty_forgiveness_period": "604800000000000"
    });

    let init_args = serde_json::json!({
        "config": {
            "name": "Sample DAO",
            "purpose": "Testing DAO for sandbox",
            "metadata": ""
        },
        "policy": policy
    });

    near_api::Contract::deploy(contract_id.clone())
        .use_code(contract_code)
        .with_init_call("new", init_args)
        .unwrap()
        .with_signer(contract_signer)
        .send_to(network_config)
        .await
        .context("Failed to deploy DAO contract")?
        .assert_success();

    info!("Successfully deployed DAO contract to {}", contract_id);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("sandbox_init=info".parse().unwrap())
                .add_directive("near_sandbox=info".parse().unwrap()),
        )
        .init();

    info!("Starting NEAR Treasury Sandbox Environment");

    // Get configuration from environment
    let contracts_dir =
        std::env::var("CONTRACTS_DIR").unwrap_or_else(|_| "/app/contracts".to_string());
    let sandbox_home =
        std::env::var("SANDBOX_HOME").unwrap_or_else(|_| "/data/sandbox".to_string());
    let sandbox_home = PathBuf::from(sandbox_home);

    let rpc_port: u16 = std::env::var("SANDBOX_RPC_PORT")
        .unwrap_or_else(|_| "3031".to_string())
        .parse()
        .unwrap_or(3031);
    let net_port: u16 = std::env::var("SANDBOX_NET_PORT")
        .unwrap_or_else(|_| "24567".to_string())
        .parse()
        .unwrap_or(24567);

    // Get the default genesis account credentials
    let genesis_account = GenesisAccount::default();

    // Define additional accounts for genesis
    let additional_accounts = vec![
        GenesisAccount {
            account_id: "wrap.near".parse().unwrap(),
            balance: NearToken::from_near(1000),
            private_key: genesis_account.private_key.clone(),
            public_key: genesis_account.public_key.clone(),
        },
        GenesisAccount {
            account_id: "intents.near".parse().unwrap(),
            balance: NearToken::from_near(1000),
            private_key: genesis_account.private_key.clone(),
            public_key: genesis_account.public_key.clone(),
        },
        GenesisAccount {
            account_id: "omft.near".parse().unwrap(),
            balance: NearToken::from_near(1000),
            private_key: genesis_account.private_key.clone(),
            public_key: genesis_account.public_key.clone(),
        },
        GenesisAccount {
            account_id: "sputnik-dao.near".parse().unwrap(),
            balance: NearToken::from_near(1000),
            private_key: genesis_account.private_key.clone(),
            public_key: genesis_account.public_key.clone(),
        },
    ];

    // Ensure sandbox binary is available
    info!("Ensuring sandbox binary is available...");
    let bin_path = ensure_sandbox_binary().await?;
    info!("Using sandbox binary at {:?}", bin_path);

    // Check if this is a fresh install or resuming from persistent storage
    let is_fresh_install = !sandbox_home.join("genesis.json").exists();

    if is_fresh_install {
        info!("Fresh install detected - initializing sandbox home directory");

        // Initialize sandbox home
        init_sandbox_home(&bin_path, &sandbox_home).await?;

        // Configure genesis with additional accounts
        configure_genesis(&sandbox_home, &additional_accounts)?;
    } else {
        info!(
            "Existing sandbox home detected at {:?} - resuming",
            sandbox_home
        );
    }

    // Start sandbox
    info!("Starting NEAR sandbox...");
    let mut sandbox_process = start_sandbox(&bin_path, &sandbox_home, rpc_port, net_port).await?;

    let rpc_url = format!("http://127.0.0.1:{}", rpc_port);

    // Wait for sandbox to be ready
    wait_for_sandbox(&rpc_url).await?;

    info!("Sandbox started at RPC address: {}", rpc_url);

    // Configure network using the sandbox RPC address
    let network_config = NetworkConfig::from_rpc_url("sandbox", rpc_url.parse().unwrap());

    // Only deploy contracts on fresh install
    if is_fresh_install {
        info!("================================================");
        info!("Initializing contracts (fresh install)...");
        info!("================================================");

        // Import contracts from mainnet
        for (account_id, mainnet_id) in [
            ("wrap.near", "wrap.near"),
            ("intents.near", "intents.near"),
            ("omft.near", "omft.near"),
            ("sputnik-dao.near", "sputnik-dao.near"),
        ] {
            let account_id: AccountId = account_id.parse().unwrap();
            if let Err(e) = import_contract(&network_config, &account_id, mainnet_id).await {
                error!("Failed to import {}: {}", mainnet_id, e);
            }
        }

        // Initialize sputnik-dao.near factory
        info!("Initializing sputnik-dao.near factory...");
        let sputnik_dao_id: AccountId = "sputnik-dao.near".parse().unwrap();
        if let Err(e) = near_api::Contract(sputnik_dao_id.clone())
            .call_function("new", serde_json::json!({}))
            .unwrap()
            .transaction()
            .gas(NearGas::from_tgas(300))
            .with_signer(sputnik_dao_id.clone(), get_genesis_signer())
            .send_to(&network_config)
            .await
        {
            error!("Failed to initialize sputnik-dao.near: {}", e);
        }

        // Create and deploy bulk payment contract
        let near_id: AccountId = "near".parse().unwrap();
        let bulk_payment_id: AccountId = "bulk-payment.near".parse().unwrap();

        if let Err(e) = create_account(
            &bulk_payment_id,
            &near_id,
            NearToken::from_near(100),
            &network_config,
        )
        .await
        {
            error!("Failed to create bulk-payment account: {}", e);
        } else {
            let bulk_payment_wasm = format!("{}/bulk_payment.wasm", contracts_dir);
            if std::path::Path::new(&bulk_payment_wasm).exists() {
                if let Err(e) =
                    deploy_bulk_payment_contract(&network_config, &bulk_payment_id, &bulk_payment_wasm)
                        .await
                {
                    error!("Failed to deploy bulk payment contract: {}", e);
                }
            } else {
                warn!(
                    "Bulk payment contract not found at {}, skipping deployment",
                    bulk_payment_wasm
                );
            }
        }

        // Deploy sample DAO if available
        let dao_wasm = format!("{}/sputnikdao2.wasm", contracts_dir);
        if std::path::Path::new(&dao_wasm).exists() {
            let dao_id: AccountId = "sample-dao.near".parse().unwrap();

            if let Err(e) = create_account(
                &dao_id,
                &near_id,
                NearToken::from_near(100),
                &network_config,
            )
            .await
            {
                error!("Failed to create DAO account: {}", e);
            } else if let Err(e) = deploy_dao_contract(&network_config, &dao_id, &dao_wasm).await {
                error!("Failed to deploy DAO contract: {}", e);
            }
        } else {
            info!("DAO contract not found at {}, skipping", dao_wasm);
        }
    } else {
        info!("================================================");
        info!("Resuming from persistent storage - skipping contract deployment");
        info!("================================================");
    }

    let bulk_payment_id: AccountId = "bulk-payment.near".parse().unwrap();

    info!("================================================");
    info!(
        "Sandbox {} complete!",
        if is_fresh_install {
            "initialization"
        } else {
            "resumed"
        }
    );
    info!("================================================");
    info!("");
    info!("RPC URL: {}", rpc_url);
    info!("Available contracts:");
    info!("  - wrap.near");
    info!("  - intents.near");
    info!("  - omft.near");
    info!("  - sputnik-dao.near (DAO factory)");
    info!("  - {}", bulk_payment_id);
    info!("");
    info!("Persistent home directory: {:?}", sandbox_home);
    info!("");

    // Keep the sandbox running
    info!("Sandbox is running. Press Ctrl+C to stop.");

    // Wait for either Ctrl+C or sandbox process exit
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("Received Ctrl+C, shutting down...");
        }
        status = sandbox_process.wait() => {
            match status {
                Ok(exit_status) => {
                    if exit_status.success() {
                        info!("Sandbox process exited normally");
                    } else {
                        error!("Sandbox process exited with status: {}", exit_status);
                    }
                }
                Err(e) => {
                    error!("Error waiting for sandbox process: {}", e);
                }
            }
        }
    }

    info!("Shutting down sandbox...");
    let _ = sandbox_process.kill().await;

    Ok(())
}
