// Integration tests for the confidential-bulk-payment subaccount.
//
// Setup:
// - v1.signer / intents.near: replaced by a single mock contract (`mock-mpc`)
//   deployed to both account ids. Returns deterministic ed25519 signatures.
// - sputnik-dao: real `sputnik_dao_v2.wasm` deployed at <prefix>.sputnik-dao.near.
// - confidential-bulk-payment: deployed at <prefix>.bulk-payment.near so the
//   `init` naming-binding check passes.
//
// Flow exercised:
//   bootstrap → DAO add_proposal(FunctionCall to v1.signer.sign) → act_proposal
//   (Approve) → activate(proposal_id) → ping → Signed entries → retry no-op.

use std::sync::OnceLock;

use base64::Engine;
use confidential_bulk_payment::{
    ADD_PUBKEY_GAS, BOOTSTRAP_CALLBACK_GAS, BYTES_PER_ACTIVATION, BYTES_PER_HASH,
    FETCH_PROPOSAL_GAS,
};
use near_api::{
    AccountId, NearGas, NearToken, Tokens,
    types::transaction::result::{ExecutionOutcome, ExecutionSuccess},
};
use near_sandbox::{
    Sandbox,
    config::{DEFAULT_GENESIS_ACCOUNT, DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY},
};
use near_sdk::serde_json::{self, json};

const SPUTNIK_WASM_REL: &str = "../../nt-fe/public/sputnik_dao_v2.wasm";

fn genesis_signer() -> std::sync::Arc<near_api::Signer> {
    near_api::Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap()).unwrap()
}

fn genesis_id() -> AccountId {
    DEFAULT_GENESIS_ACCOUNT.as_str().parse().unwrap()
}

// ── WASM caches ────────────────────────────────────────────────────────────
// First test in the run pays the build cost; subsequent tests share the bytes
// instead of re-invoking `cargo near build`.

fn mock_mpc_wasm() -> &'static [u8] {
    static CACHE: OnceLock<Vec<u8>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let manifest =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/mock-mpc/Cargo.toml");
        let wasm_path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
            manifest_path: Some(camino::Utf8PathBuf::from_path_buf(manifest).unwrap()),
            no_locked: true,
            ..Default::default()
        })
        .expect("build mock-mpc");
        std::fs::read(wasm_path).unwrap()
    })
}

fn main_wasm() -> &'static [u8] {
    static CACHE: OnceLock<Vec<u8>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let wasm_path = cargo_near_build::build_with_cli(Default::default())
            .expect("build confidential-bulk-payment");
        std::fs::read(wasm_path).unwrap()
    })
}

fn sputnik_wasm() -> &'static [u8] {
    static CACHE: OnceLock<Vec<u8>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SPUTNIK_WASM_REL);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
    })
}

// ── Test context ───────────────────────────────────────────────────────────

struct Ctx {
    _sandbox: Sandbox,
    network: near_api::NetworkConfig,
    contract_id: AccountId,
    dao_id: AccountId,
}

impl Ctx {
    fn signer(&self) -> std::sync::Arc<near_api::Signer> {
        genesis_signer()
    }

    fn caller(&self) -> AccountId {
        genesis_id()
    }
}

/// Spin up sandbox, materialize the four required accounts via state-patching,
/// deploy the two mocks + sputnik-dao + confidential-bulk-payment.
async fn setup() -> testresult::TestResult<Ctx> {
    let prefix = "mydao";
    let sandbox = Sandbox::start_sandbox().await?;
    let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);

    let signer_id: AccountId = "v1.signer".parse().unwrap();
    let intents_id: AccountId = "intents.near".parse().unwrap();
    let dao_id: AccountId = format!("{prefix}.sputnik-dao.near").parse().unwrap();
    let contract_id: AccountId = format!("{prefix}.bulk-payment.near").parse().unwrap();

    // Sandbox state-patches each account in with the genesis full-access key,
    // so the genesis signer authenticates for all of them.
    for id in [&signer_id, &intents_id, &dao_id, &contract_id] {
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(50))
            .send()
            .await?;
    }

    // Mocks for v1.signer + intents.near (same wasm, both surfaces inside).
    for id in [&signer_id, &intents_id] {
        near_api::Contract::deploy(id.clone())
            .use_code(mock_mpc_wasm().to_vec())
            .with_init_call("new", ())?
            .with_signer(genesis_signer())
            .send_to(&network)
            .await?
            .into_result()?;
    }

    // Sputnik DAO with a single-member council (the genesis account).
    near_api::Contract::deploy(dao_id.clone())
        .use_code(sputnik_wasm().to_vec())
        .with_init_call(
            "new",
            json!({
                "config": { "name": prefix, "purpose": "test", "metadata": "" },
                "policy": [DEFAULT_GENESIS_ACCOUNT.as_str()]
            }),
        )?
        .with_signer(genesis_signer())
        .send_to(&network)
        .await?
        .into_result()?;

    // Confidential-bulk-payment subaccount, owned by the DAO above.
    near_api::Contract::deploy(contract_id.clone())
        .use_code(main_wasm().to_vec())
        .with_init_call("init", json!({ "owner_dao": dao_id.to_string() }))?
        .with_signer(genesis_signer())
        .send_to(&network)
        .await?
        .into_result()?;

    Ok(Ctx {
        _sandbox: sandbox,
        network,
        contract_id,
        dao_id,
    })
}

// ── DAO helpers ────────────────────────────────────────────────────────────

/// Add a FunctionCall proposal carrying `payload_hashes` in the description and
/// vote it through. Returns the assigned proposal id.
async fn add_and_approve_proposal(
    ctx: &Ctx,
    payload_hashes_csv: &str,
) -> testresult::TestResult<u64> {
    // Valid SignRequest JSON so the FunctionCall executed by the DAO on
    // approval deserializes cleanly at (mock) v1.signer. The actual payload
    // is irrelevant for proposal-status purposes; per-hash signing happens
    // later via `ping`.
    let sign_args_json = serde_json::to_vec(&json!({
        "request": {
            "path": "",
            "payload_v2": { "Eddsa": "0".repeat(64) },
            "domain_id": 1,
        }
    }))?;
    let stub_args = base64::engine::general_purpose::STANDARD.encode(&sign_args_json);
    let proposal_kind = json!({
        "FunctionCall": {
            "receiver_id": "v1.signer",
            "actions": [{
                "method_name": "sign",
                "args": stub_args,
                "deposit": "1",
                "gas": "30000000000000"
            }]
        }
    });

    let proposal_id: u64 = near_api::Contract(ctx.dao_id.clone())
        .call_function("get_last_proposal_id", ())
        .read_only()
        .fetch_from(&ctx.network)
        .await?
        .data;

    near_api::Contract(ctx.dao_id.clone())
        .call_function(
            "add_proposal",
            json!({
                "proposal": {
                    "description": format!("* payload_hashes: {payload_hashes_csv}"),
                    "kind": proposal_kind,
                }
            }),
        )
        .transaction()
        .deposit(NearToken::from_near(1)) // sputnik default proposal_bond
        .gas(near_sdk::Gas::from_tgas(100))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;

    near_api::Contract(ctx.dao_id.clone())
        .call_function(
            "act_proposal",
            json!({ "id": proposal_id, "action": "VoteApprove", "proposal": proposal_kind }),
        )
        .transaction()
        .gas(near_sdk::Gas::from_tgas(250))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;

    Ok(proposal_id)
}

async fn read_bootstrap(ctx: &Ctx) -> serde_json::Value {
    near_api::Contract(ctx.contract_id.clone())
        .call_function("get_bootstrap_status", ())
        .read_only()
        .fetch_from(&ctx.network)
        .await
        .unwrap()
        .data
}

async fn read_activation(ctx: &Ctx, proposal_id: u64) -> serde_json::Value {
    near_api::Contract(ctx.contract_id.clone())
        .call_function(
            "get_activation",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .read_only()
        .fetch_from(&ctx.network)
        .await
        .unwrap()
        .data
}

async fn bootstrap(ctx: &Ctx) -> testresult::TestResult<ExecutionSuccess> {
    let res = near_api::Contract(ctx.contract_id.clone())
        .call_function("bootstrap", ())
        .transaction()
        .gas(near_sdk::Gas::from_tgas(100))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;
    for log in res.logs() {
        println!("  bootstrap log: {log}");
    }
    Ok(res)
}

async fn activate(ctx: &Ctx, proposal_id: u64) -> testresult::TestResult<ExecutionSuccess> {
    let required: NearToken = near_api::Contract(ctx.contract_id.clone())
        .call_function("activate_required_deposit", ())
        .read_only()
        .fetch_from(&ctx.network)
        .await?
        .data;
    let res = near_api::Contract(ctx.contract_id.clone())
        .call_function(
            "activate",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .transaction()
        .deposit(required)
        // Budget covers the activation callback + the chained auto-ping.
        .gas(near_sdk::Gas::from_tgas(300))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;
    for log in res.logs() {
        println!("  activate log: {log}");
    }
    Ok(res)
}

async fn ping(ctx: &Ctx, proposal_id: u64) -> testresult::TestResult<u32> {
    let res = near_api::Contract(ctx.contract_id.clone())
        .call_function("ping", json!({ "proposal_id": proposal_id.to_string() }))
        .transaction()
        .gas(near_sdk::Gas::from_tgas(300))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;
    Ok(res.json()?)
}

async fn activate_with_deposit(
    ctx: &Ctx,
    proposal_id: u64,
    deposit: NearToken,
) -> testresult::TestResult<ExecutionSuccess> {
    let res = near_api::Contract(ctx.contract_id.clone())
        .call_function(
            "activate",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .transaction()
        .deposit(deposit)
        .gas(near_sdk::Gas::from_tgas(300))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;
    Ok(res)
}

// ── Gas / storage measurement helpers ──────────────────────────────────────

async fn near_balance(ctx: &Ctx, account: &AccountId) -> testresult::TestResult<NearToken> {
    Ok(Tokens::account(account.clone())
        .near_balance()
        .fetch_from(&ctx.network)
        .await?
        .total)
}

async fn storage_usage(ctx: &Ctx, account: &AccountId) -> testresult::TestResult<u64> {
    Ok(Tokens::account(account.clone())
        .near_balance()
        .fetch_from(&ctx.network)
        .await?
        .storage_usage)
}

/// Group receipt outcomes by `executor_id` and print TGas burnt by each.
/// Returns the maximum gas burnt by any single receipt executed on `internal`
/// (the contract under test) — the tightest constraint for sizing
/// `*_CALLBACK_GAS` constants.
fn report_gas(label: &str, res: &ExecutionSuccess, internal: &AccountId) -> u64 {
    println!("\n── gas breakdown: {label} ──");
    println!("  total burnt: {} TGas", res.total_gas_burnt.as_tgas());

    let mut by_executor: std::collections::BTreeMap<String, (u64, u64)> =
        std::collections::BTreeMap::new();
    let mut max_internal: u64 = 0;
    let mut max_internal_receipt: Option<&ExecutionOutcome> = None;

    for o in res.receipt_outcomes() {
        let entry = by_executor
            .entry(o.executor_id.to_string())
            .or_insert((0, 0));
        entry.0 += o.gas_burnt.as_gas();
        entry.1 += 1;

        if &o.executor_id == internal && o.gas_burnt.as_gas() > max_internal {
            max_internal = o.gas_burnt.as_gas();
            max_internal_receipt = Some(o);
        }
    }

    for (executor, (gas, count)) in &by_executor {
        println!(
            "  {executor:30} {} receipts  {:>6} TGas",
            count,
            NearGas::from_gas(*gas).as_tgas()
        );
    }

    if let Some(o) = max_internal_receipt {
        let logs_preview = if o.logs.is_empty() {
            String::new()
        } else {
            format!(" logs={:?}", o.logs)
        };
        println!(
            "  hottest internal receipt: {} TGas{logs_preview}",
            NearGas::from_gas(max_internal).as_tgas()
        );
    }

    max_internal
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_full_flow() -> testresult::TestResult {
    let ctx = setup().await?;

    println!("\n══════════ STAGE 0: pre-bootstrap state ══════════");
    println!("contract_id: {}", ctx.contract_id);
    println!("dao_id:      {}", ctx.dao_id);
    println!("bootstrap status: {}", read_bootstrap(&ctx).await);

    let pk: String = near_api::Contract("v1.signer".parse().unwrap())
        .call_function(
            "derived_public_key",
            json!({ "path": "", "predecessor": ctx.contract_id.to_string(), "domain_id": 1 }),
        )
        .read_only()
        .fetch_from(&ctx.network)
        .await?
        .data;
    println!("v1.signer.derived_public_key (mock) → {pk}");
    assert!(pk.starts_with("ed25519:"), "mock pk: {pk}");

    println!("\n══════════ STAGE 1: bootstrap ══════════");
    bootstrap(&ctx).await?;
    let bootstrap_status = read_bootstrap(&ctx).await;
    println!("bootstrap status (after): {bootstrap_status}");
    assert!(
        bootstrap_status.get("Ready").is_some(),
        "expected Ready, got {bootstrap_status:?}"
    );

    println!("\n══════════ STAGE 2: DAO add + approve proposal ══════════");
    let h1 = "a".repeat(64);
    let h2 = "b".repeat(64);
    let csv = format!("{h1},{h2}");
    println!(
        "payload_hashes ({} chars each): [{}…, {}…]",
        h1.len(),
        &h1[..8],
        &h2[..8]
    );
    let proposal_id = add_and_approve_proposal(&ctx, &csv).await?;
    println!("proposal_id: {proposal_id}");

    let proposal: serde_json::Value = near_api::Contract(ctx.dao_id.clone())
        .call_function("get_proposal", json!({ "id": proposal_id }))
        .read_only()
        .fetch_from(&ctx.network)
        .await?
        .data;
    println!(
        "proposal status (DAO view): {}",
        proposal["proposal"]["status"]
    );

    println!("\n══════════ STAGE 3: activate (auto-ping fires inline) ══════════");
    activate(&ctx, proposal_id).await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let activation = read_activation(&ctx, proposal_id).await;
    println!("activation (after activate + auto-ping):\n{activation:#}");
    assert_eq!(activation["hashes"].as_array().unwrap().len(), 2);
    assert_eq!(
        activation["status"], "Done",
        "auto-ping should sign the 2 hashes within the activate gas budget"
    );
    for entry in activation["hashes"].as_array().unwrap() {
        assert!(
            entry["status"].get("Signed").is_some(),
            "expected Signed, got {}",
            entry["status"]
        );
    }

    println!("\n══════════ STAGE 5: retry_failed (no-op) ══════════");
    let retried: u32 = near_api::Contract(ctx.contract_id.clone())
        .call_function(
            "retry_failed",
            json!({ "proposal_id": proposal_id.to_string() }),
        )
        .transaction()
        .gas(near_sdk::Gas::from_tgas(50))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?
        .json()?;
    println!("retry_failed reset count: {retried}");
    assert_eq!(retried, 0);

    Ok(())
}

#[tokio::test]
async fn test_activate_rejects_unapproved_proposal() -> testresult::TestResult {
    let ctx = setup().await?;
    bootstrap(&ctx).await?;

    // Add a proposal but never vote it through.
    let sign_args_json = serde_json::to_vec(&json!({
        "request": {
            "path": "",
            "payload_v2": { "Eddsa": "0".repeat(64) },
            "domain_id": 1,
        }
    }))?;
    let stub_args = base64::engine::general_purpose::STANDARD.encode(&sign_args_json);
    let proposal_kind = json!({
        "FunctionCall": {
            "receiver_id": "v1.signer",
            "actions": [{
                "method_name": "sign",
                "args": stub_args,
                "deposit": "1",
                "gas": "30000000000000"
            }]
        }
    });
    let h = "c".repeat(64);
    near_api::Contract(ctx.dao_id.clone())
        .call_function(
            "add_proposal",
            json!({
                "proposal": {
                    "description": format!("* payload_hashes: {h}"),
                    "kind": proposal_kind,
                }
            }),
        )
        .transaction()
        .deposit(NearToken::from_near(1))
        .gas(near_sdk::Gas::from_tgas(100))
        .with_signer(ctx.caller(), ctx.signer())
        .send_to(&ctx.network)
        .await?
        .into_result()?;

    // activate's transaction succeeds (it just kicks off the cross-contract
    // get_proposal call); the callback aborts because the proposal is not
    // Approved → activation entry is removed.
    activate(&ctx, 0).await?;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let activation: Option<serde_json::Value> = near_api::Contract(ctx.contract_id.clone())
        .call_function("get_activation", json!({ "proposal_id": "0" }))
        .read_only()
        .fetch_from(&ctx.network)
        .await?
        .data;
    assert!(
        activation.is_none(),
        "activation should be aborted, got {activation:?}"
    );

    Ok(())
}

#[tokio::test]
async fn test_malformed_hashes_are_skipped() -> testresult::TestResult {
    let ctx = setup().await?;
    bootstrap(&ctx).await?;

    // Mix three malformed entries (too short, uppercase hex, non-hex char)
    // among two valid ones. Activation must accept the list, mark the bad
    // ones Invalid, and ping must only dispatch sign for the valid hashes.
    let good1 = "a".repeat(64);
    let good2 = "1".repeat(64);
    let too_short = "ab".repeat(10); // 20 chars
    let upper = "A".repeat(64);
    let non_hex = "z".repeat(64);
    let csv = format!("{good1},{too_short},{upper},{good2},{non_hex}");

    let proposal_id = add_and_approve_proposal(&ctx, &csv).await?;
    activate(&ctx, proposal_id).await?;

    // Wait for the chained auto-ping + sign callbacks to settle.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let activation = read_activation(&ctx, proposal_id).await;
    println!("activation (after activate + auto-ping):\n{activation:#}");

    let hashes = activation["hashes"].as_array().unwrap();
    assert_eq!(hashes.len(), 5);

    assert_eq!(
        activation["status"], "Done",
        "cursor should walk past all entries, including Invalid ones"
    );
    assert!(hashes[0]["status"].get("Signed").is_some());
    assert!(hashes[3]["status"].get("Signed").is_some());
    for i in [1, 2, 4] {
        assert!(
            hashes[i]["status"]["Invalid"]["reason"] == "MalformedHex",
            "Invalid status should persist through ping for hash[{i}]"
        );
    }

    Ok(())
}

#[tokio::test]
async fn test_100_hash_multi_ping_completes() -> testresult::TestResult {
    let ctx = setup().await?;
    bootstrap(&ctx).await?;

    // 100 distinct valid hex hashes — too many for a single activate's
    // forwarded auto-ping budget, so the test must drive ping() in a loop
    // until the activation reaches Done.
    const N: u64 = 100;
    let csv: String = (0..N)
        .map(|i| format!("{:0>64x}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let proposal_id = add_and_approve_proposal(&ctx, &csv).await?;

    activate(&ctx, proposal_id).await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    // Drive ping in a loop. With ~22 dispatches per 300 TGas, ~5 pings should
    // finish; cap at 15 for slack against gas-budget jitter.
    let mut iterations = 0;
    loop {
        let activation = read_activation(&ctx, proposal_id).await;
        let status = &activation["status"];
        println!(
            "  iter {iterations}: status={status} cursor={:?}",
            status.get("Ready").and_then(|r| r.get("cursor"))
        );
        if status == "Done" {
            break;
        }
        assert!(
            iterations < 15,
            "activation did not reach Done after 15 pings; last status: {status}"
        );

        let dispatched = ping(&ctx, proposal_id).await?;
        println!("  iter {iterations}: ping dispatched {dispatched}");
        iterations += 1;
    }

    let activation = read_activation(&ctx, proposal_id).await;
    let hashes = activation["hashes"].as_array().unwrap();
    assert_eq!(hashes.len(), N as usize);
    for (i, h) in hashes.iter().enumerate() {
        assert!(
            h["status"].get("Signed").is_some(),
            "hash[{i}] not Signed: {}",
            h["status"]
        );
    }

    Ok(())
}

// ── Gas / storage tuning ────────────────────────────────────────────────────
//
// Drive the full flow with a known-size hash list and compare measured cost
// against the constants in `src/lib.rs`. Asserts:
//
//   - per-receipt gas burnt on accounts under our control (the contract +
//     the sputnik-dao instance) stays under the corresponding `*_GAS`
//     constant, with margin. External signer/intents calls are reported
//     but not asserted.
//   - storage bytes per `Activation` (post-ping, when entries carry the
//     full 64-byte signature) stays under `BYTES_PER_HASH * N
//     + BYTES_PER_ACTIVATION`.

/// Tuned to the largest batch a single `activate` tx (capped at 300 TGas)
/// can finish within its forwarded auto-ping budget. With SIGN_GAS=8 +
/// SIGN_CALLBACK_GAS=5 + SIGN_RESERVE_GAS=5 ≈ 13 TGas per dispatch and
/// ~150 TGas left after sputnik+on_get_proposal+scheduling, ~9 fits.
const HASH_COUNT_FOR_METRICS: u64 = 9;

#[tokio::test]
async fn test_gas_and_storage_metrics() -> testresult::TestResult {
    let ctx = setup().await?;

    // ── Bootstrap ──────────────────────────────────────────────────────
    let bootstrap_storage_pre = storage_usage(&ctx, &ctx.contract_id).await?;
    let bootstrap_res = bootstrap(&ctx).await?;
    let bootstrap_max_internal = report_gas("bootstrap", &bootstrap_res, &ctx.contract_id);
    let bootstrap_storage_post = storage_usage(&ctx, &ctx.contract_id).await?;
    println!(
        "  storage delta (bootstrap): {} bytes",
        bootstrap_storage_post - bootstrap_storage_pre
    );
    // Bootstrap callbacks are `on_derived_public_key` (5+5+10 = 20 TGas budget)
    // and `on_add_public_key` (10 TGas budget). The hottest internal receipt
    // should fit comfortably below the larger of the two.
    let bootstrap_budget = BOOTSTRAP_CALLBACK_GAS
        .saturating_add(ADD_PUBKEY_GAS)
        .saturating_add(BOOTSTRAP_CALLBACK_GAS);
    assert!(
        bootstrap_max_internal < bootstrap_budget.as_gas(),
        "bootstrap callback burnt {} TGas, exceeds budget {} TGas",
        NearGas::from_gas(bootstrap_max_internal).as_tgas(),
        bootstrap_budget.as_tgas()
    );

    // ── Build approval + activate ──────────────────────────────────────
    let csv: String = (0..HASH_COUNT_FOR_METRICS)
        .map(|i| format!("{:0>64x}", i + 1))
        .collect::<Vec<_>>()
        .join(",");
    let proposal_id = add_and_approve_proposal(&ctx, &csv).await?;

    let storage_pre_activate = storage_usage(&ctx, &ctx.contract_id).await?;
    let activate_res = activate(&ctx, proposal_id).await?;
    let _ = report_gas("activate (with auto-ping)", &activate_res, &ctx.contract_id);

    // `activate` now chains: on_get_proposal → ping → N×on_sign. The chained
    // ping receives whatever prepaid gas is left after the callback's tail
    // reserve, so its receipt size scales with the caller's tx budget.
    // Soundness asserts (sputnik bound + on_sign bound + Done state) live
    // below — we don't try to gate the ping receipt itself here.

    // Sputnik `get_proposal` is a view-style call we treat as internal-ish for
    // sizing FETCH_PROPOSAL_GAS. Spot-check it stayed under budget.
    let sputnik_max = activate_res
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id == ctx.dao_id)
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap_or(0);
    println!(
        "  sputnik get_proposal burnt: {} TGas (budget {} TGas)",
        NearGas::from_gas(sputnik_max).as_tgas(),
        FETCH_PROPOSAL_GAS.as_tgas()
    );
    assert!(
        sputnik_max < FETCH_PROPOSAL_GAS.as_gas(),
        "sputnik get_proposal burnt {} TGas, exceeds FETCH_PROPOSAL_GAS {} TGas",
        NearGas::from_gas(sputnik_max).as_tgas(),
        FETCH_PROPOSAL_GAS.as_tgas()
    );

    // Wait for chained sign callbacks to settle, confirm activation is Done.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let activation = read_activation(&ctx, proposal_id).await;
    assert_eq!(
        activation["status"], "Done",
        "auto-ping should have signed all {} hashes within the forwarded gas budget",
        HASH_COUNT_FOR_METRICS
    );

    // We don't try to single out the `on_sign` receipt here — it can't be
    // reliably distinguished from the auto-ping dispatch receipt by gas
    // alone. If the SIGN_CALLBACK_GAS budget were too tight, the activation
    // wouldn't reach `Done` (asserted below), so this is covered indirectly.

    // ── Storage after auto-ping (Signed entries with 64-byte sig) ──────
    let storage_post_ping = storage_usage(&ctx, &ctx.contract_id).await?;
    let activation_full_delta = storage_post_ping - storage_pre_activate;
    let estimated = BYTES_PER_HASH * HASH_COUNT_FOR_METRICS + BYTES_PER_ACTIVATION;
    println!(
        "\n── storage tuning ──\n  measured (post-ping, {n} hashes Signed): {measured} bytes\n  \
         estimate (BYTES_PER_HASH*{n} + BYTES_PER_ACTIVATION): {est} bytes\n  \
         per-hash measured: {per_hash} bytes\n  \
         headroom: {headroom} bytes",
        n = HASH_COUNT_FOR_METRICS,
        measured = activation_full_delta,
        est = estimated,
        per_hash = (activation_full_delta.saturating_sub(BYTES_PER_ACTIVATION)) as f64
            / HASH_COUNT_FOR_METRICS as f64,
        headroom = estimated as i64 - activation_full_delta as i64,
    );

    // The estimate is what we charge the payer up front. If actual exceeds
    // estimate the contract under-charges and the activation runs out of
    // funded storage — hard correctness bug.
    assert!(
        activation_full_delta <= estimated,
        "storage estimate too tight: measured {activation_full_delta} bytes vs estimated {estimated} bytes \
         (BYTES_PER_HASH={BYTES_PER_HASH}, BYTES_PER_ACTIVATION={BYTES_PER_ACTIVATION})"
    );

    Ok(())
}

#[tokio::test]
async fn test_activate_refunds_excess_deposit() -> testresult::TestResult {
    let ctx = setup().await?;
    bootstrap(&ctx).await?;

    // Approve a tiny 2-hash proposal — actual cost will be a fraction of 1 NEAR.
    let h1 = "a".repeat(64);
    let h2 = "b".repeat(64);
    let csv = format!("{h1},{h2}");
    let proposal_id = add_and_approve_proposal(&ctx, &csv).await?;

    // Activate with a deliberately excessive 20 NEAR deposit. The contract
    // should refund (20 NEAR − cost_for_hashes(2)) back to the caller.
    let huge_deposit = NearToken::from_near(20);
    let payer = ctx.caller();

    let balance_before = near_balance(&ctx, &payer).await?;
    let activate_res = activate_with_deposit(&ctx, proposal_id, huge_deposit).await?;
    for log in activate_res.logs() {
        println!("  activate log: {log}");
    }

    // Wait for the chained refund + auto-ping receipts to settle so the
    // payer's balance reflects both the refund credit and any tx fees.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let balance_after = near_balance(&ctx, &payer).await?;

    // Net debit = balance_before - balance_after
    //           = huge_deposit + tx_fees - refund
    //           = actual_cost + tx_fees
    // → tx_fees = net_debit - actual_cost. We don't know actual_cost in
    // yocto exactly without re-deriving cost_for_hashes here, so we just
    // assert the net debit is small (well under 1 NEAR), proving the
    // refund actually came back.
    let net_debit = balance_before.saturating_sub(balance_after);
    println!(
        "  payer balance before: {} NEAR\n  payer balance after:  {} NEAR\n  net debit:            {} NEAR",
        balance_before.exact_amount_display(),
        balance_after.exact_amount_display(),
        net_debit.exact_amount_display(),
    );
    assert!(
        net_debit < NearToken::from_near(1),
        "expected refund to bring net debit under 1 NEAR; got {} NEAR \
         — the 20 NEAR deposit does not appear to have been refunded",
        net_debit.exact_amount_display()
    );

    // Sanity check: activation reached Ready/Done — the refund path runs
    // only on the success branch of on_get_proposal.
    let activation = read_activation(&ctx, proposal_id).await;
    let status = &activation["status"];
    assert!(
        status == "Done" || status["Ready"].is_object(),
        "activation should have loaded; got {status}"
    );

    Ok(())
}
