//! Neardata block API client
//!
//! Fetches full block data from mainnet.neardata.xyz to extract receipt metadata
//! (counterparty, action_kind, method_name, transaction hashes) in a single HTTP call,
//! replacing multiple individual RPC calls during gap filling.

use reqwest::Client;
use serde::Deserialize;
use std::error::Error;

// ── Client ──────────────────────────────────────────────────────────────────

pub struct NeardataClient {
    client: Client,
    base_url: String,
    api_key: Option<String>,
}

impl Default for NeardataClient {
    fn default() -> Self {
        Self::new()
    }
}

impl NeardataClient {
    pub fn new() -> Self {
        let base_url = std::env::var("NEARDATA_BASE_URL")
            .unwrap_or_else(|_| "https://mainnet.neardata.xyz".to_string());
        Self {
            client: Client::new(),
            base_url,
            api_key: None,
        }
    }

    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Create from environment (reads FASTNEAR_API_KEY)
    pub fn from_env() -> Self {
        let mut client = Self::new();
        if let Ok(key) = std::env::var("FASTNEAR_API_KEY") {
            client.api_key = Some(key);
        }
        client
    }

    /// Fetch block data and extract receipts/transactions relevant to an account.
    pub async fn fetch_account_block_data(
        &self,
        block_height: u64,
        account_id: &str,
    ) -> Result<NeardataAccountBlock, Box<dyn Error + Send + Sync>> {
        let url = format!("{}/v0/block/{}", self.base_url, block_height);

        let mut req = self.client.get(&url);
        if let Some(api_key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req.send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "Neardata API error at block {}: {} - {}",
                block_height, status, body
            )
            .into());
        }

        let block: NeardataBlock = response.json().await?;
        Ok(Self::parse_block(block, account_id))
    }

    /// Parse a neardata block JSON into account-filtered data.
    /// Separated from fetch for testability.
    fn parse_block(block: NeardataBlock, account_id: &str) -> NeardataAccountBlock {
        let block_height = block.block.header.height;

        let timestamp_nanos = block.block.header.timestamp as i64;

        let mut receipts = Vec::new();
        let mut transactions = Vec::new();
        let mut execution_outcomes = Vec::new();

        for shard in &block.shards {
            // Receipts from chunks: these are the incoming action receipts
            if let Some(chunk) = &shard.chunk {
                for r in &chunk.receipts {
                    if r.receiver_id == account_id
                        && let Some(action) = &r.receipt.action
                    {
                        let (action_kind, method_name, deposit) =
                            extract_action_info(&action.actions);
                        receipts.push(AccountReceipt {
                            receipt_id: r.receipt_id.clone(),
                            predecessor_id: r.predecessor_id.clone(),
                            receiver_id: r.receiver_id.clone(),
                            signer_id: action.signer_id.clone(),
                            action_kind,
                            method_name,
                            deposit,
                        });
                    }
                }

                // Transactions in chunks
                for t in &chunk.transactions {
                    let tx = &t.transaction;
                    if tx.signer_id == account_id || tx.receiver_id == account_id {
                        let receipt_ids = t
                            .outcome
                            .as_ref()
                            .and_then(|o| {
                                o.execution_outcome
                                    .as_ref()
                                    .map(|eo| eo.outcome.receipt_ids.clone())
                            })
                            .unwrap_or_default();
                        transactions.push(AccountTransaction {
                            hash: tx.hash.clone(),
                            signer_id: tx.signer_id.clone(),
                            receiver_id: tx.receiver_id.clone(),
                            receipt_ids,
                        });
                    }
                }
            }

            // Receipt execution outcomes: extract tx_hash, logs, and child receipt_ids
            for reo in &shard.receipt_execution_outcomes {
                if let Some(eo) = &reo.execution_outcome {
                    let executor = eo.outcome.executor_id.as_str();
                    if executor == account_id {
                        execution_outcomes.push(AccountExecutionOutcome {
                            receipt_id: eo.id.clone(),
                            executor_id: executor.to_string(),
                            logs: eo.outcome.logs.clone(),
                            receipt_ids: eo.outcome.receipt_ids.clone(),
                            tx_hash: reo.tx_hash.clone(),
                        });

                        // Also populate transactions from tx_hash if not already present
                        if let Some(tx_hash) = &reo.tx_hash
                            && !transactions.iter().any(|t| t.hash == *tx_hash)
                        {
                            transactions.push(AccountTransaction {
                                hash: tx_hash.clone(),
                                signer_id: String::new(),
                                receiver_id: String::new(),
                                receipt_ids: vec![eo.id.clone()],
                            });
                        }
                    }
                }
            }
        }

        NeardataAccountBlock {
            block_height,
            timestamp_nanos,
            receipts,
            transactions,
            execution_outcomes,
        }
    }
}

// ── Extracted account-level types ───────────────────────────────────────────

/// Block data filtered to a specific account
pub struct NeardataAccountBlock {
    pub block_height: u64,
    pub timestamp_nanos: i64,
    pub receipts: Vec<AccountReceipt>,
    pub transactions: Vec<AccountTransaction>,
    pub execution_outcomes: Vec<AccountExecutionOutcome>,
}

/// A receipt relevant to the monitored account
pub struct AccountReceipt {
    pub receipt_id: String,
    pub predecessor_id: String,
    pub receiver_id: String,
    pub signer_id: String,
    pub action_kind: Option<String>,
    pub method_name: Option<String>,
    pub deposit: Option<String>,
}

/// A transaction involving the monitored account
pub struct AccountTransaction {
    pub hash: String,
    pub signer_id: String,
    pub receiver_id: String,
    pub receipt_ids: Vec<String>,
}

/// An execution outcome for the monitored account
pub struct AccountExecutionOutcome {
    /// The receipt ID that was executed
    pub receipt_id: String,
    /// The account that executed this receipt
    pub executor_id: String,
    /// Log lines emitted during execution
    pub logs: Vec<String>,
    /// Child receipt IDs produced by this execution
    pub receipt_ids: Vec<String>,
    /// The originating transaction hash
    pub tx_hash: Option<String>,
}

// ── Serde types for neardata JSON ───────────────────────────────────────────

#[derive(Deserialize)]
struct NeardataBlock {
    block: BlockWrapper,
    #[serde(default)]
    shards: Vec<NeardataShard>,
}

#[derive(Deserialize)]
struct BlockWrapper {
    header: BlockHeader,
}

#[derive(Deserialize)]
struct BlockHeader {
    #[allow(dead_code)]
    height: u64,
    timestamp: u64,
}

#[derive(Deserialize)]
struct NeardataShard {
    chunk: Option<NeardataChunk>,
    #[serde(default)]
    receipt_execution_outcomes: Vec<ReceiptExecutionOutcome>,
}

#[derive(Deserialize)]
struct NeardataChunk {
    #[serde(default)]
    receipts: Vec<NeardataReceipt>,
    #[serde(default)]
    transactions: Vec<NeardataTransaction>,
}

#[derive(Deserialize)]
struct NeardataReceipt {
    receipt_id: String,
    predecessor_id: String,
    receiver_id: String,
    receipt: ReceiptBody,
}

#[derive(Deserialize)]
struct ReceiptBody {
    #[serde(rename = "Action")]
    action: Option<ActionBody>,
}

#[derive(Deserialize)]
struct ActionBody {
    #[serde(default)]
    actions: Vec<NeardataAction>,
    #[serde(default)]
    signer_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NeardataAction {
    Transfer(TransferAction),
    FunctionCall(FunctionCallAction),
    #[allow(dead_code)]
    Other(serde_json::Value),
}

#[derive(Deserialize)]
struct TransferAction {
    #[serde(rename = "Transfer")]
    transfer: TransferDeposit,
}

#[derive(Deserialize)]
struct TransferDeposit {
    deposit: String,
}

#[derive(Deserialize)]
struct FunctionCallAction {
    #[serde(rename = "FunctionCall")]
    function_call: FunctionCallData,
}

#[derive(Deserialize)]
struct FunctionCallData {
    method_name: String,
    deposit: String,
}

#[derive(Deserialize)]
struct NeardataTransaction {
    transaction: TransactionInner,
    outcome: Option<TransactionOutcome>,
}

#[derive(Deserialize)]
struct TransactionInner {
    hash: String,
    signer_id: String,
    receiver_id: String,
}

#[derive(Deserialize)]
struct TransactionOutcome {
    execution_outcome: Option<ExecutionOutcomeWrapper>,
}

#[derive(Deserialize)]
struct ReceiptExecutionOutcome {
    execution_outcome: Option<ExecutionOutcomeWrapper>,
    tx_hash: Option<String>,
}

#[derive(Deserialize)]
struct ExecutionOutcomeWrapper {
    #[serde(default)]
    id: String,
    outcome: OutcomeData,
}

#[derive(Deserialize)]
struct OutcomeData {
    #[serde(default)]
    executor_id: String,
    #[serde(default)]
    receipt_ids: Vec<String>,
    #[serde(default)]
    logs: Vec<String>,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn extract_action_info(
    actions: &[NeardataAction],
) -> (Option<String>, Option<String>, Option<String>) {
    for action in actions {
        match action {
            NeardataAction::Transfer(t) => {
                return (
                    Some("TRANSFER".to_string()),
                    None,
                    Some(t.transfer.deposit.clone()),
                );
            }
            NeardataAction::FunctionCall(f) => {
                return (
                    Some("FUNCTION_CALL".to_string()),
                    Some(f.function_call.method_name.clone()),
                    Some(f.function_call.deposit.clone()),
                );
            }
            NeardataAction::Other(_) => continue,
        }
    }
    (None, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_action_transfer() {
        let actions = vec![NeardataAction::Transfer(TransferAction {
            transfer: TransferDeposit {
                deposit: "1000000000000000000000000".to_string(),
            },
        })];
        let (kind, method, deposit) = extract_action_info(&actions);
        assert_eq!(kind.as_deref(), Some("TRANSFER"));
        assert!(method.is_none());
        assert_eq!(deposit.as_deref(), Some("1000000000000000000000000"));
    }

    #[test]
    fn test_extract_action_function_call() {
        let actions = vec![NeardataAction::FunctionCall(FunctionCallAction {
            function_call: FunctionCallData {
                method_name: "ft_transfer".to_string(),
                deposit: "1".to_string(),
            },
        })];
        let (kind, method, deposit) = extract_action_info(&actions);
        assert_eq!(kind.as_deref(), Some("FUNCTION_CALL"));
        assert_eq!(method.as_deref(), Some("ft_transfer"));
        assert_eq!(deposit.as_deref(), Some("1"));
    }

    #[test]
    fn test_deserialize_transfer_action() {
        let json = r#"{"Transfer": {"deposit": "2870000000000000000000"}}"#;
        let action: NeardataAction = serde_json::from_str(json).unwrap();
        match action {
            NeardataAction::Transfer(t) => {
                assert_eq!(t.transfer.deposit, "2870000000000000000000");
            }
            _ => panic!("Expected Transfer"),
        }
    }

    #[test]
    fn test_deserialize_function_call_action() {
        let json = r#"{"FunctionCall": {"method_name": "act_proposal", "deposit": "100000000000000000000000", "gas": 200000000000000, "args": "eyJpZCI6MH0="}}"#;
        let action: NeardataAction = serde_json::from_str(json).unwrap();
        match action {
            NeardataAction::FunctionCall(f) => {
                assert_eq!(f.function_call.method_name, "act_proposal");
                assert_eq!(f.function_call.deposit, "100000000000000000000000");
            }
            _ => panic!("Expected FunctionCall"),
        }
    }

    #[test]
    fn test_deserialize_receipt_body() {
        let json = r#"{
            "Action": {
                "actions": [{"Transfer": {"deposit": "2870000000000000000000"}}],
                "gas_price": "100000000",
                "input_data_ids": [],
                "is_promise_yield": false,
                "output_data_receivers": [],
                "signer_id": "sponsor.trezu.near",
                "signer_public_key": "ed25519:7r9YdTv6TGpWaC6FW5MWjA3h2EAiASsDuvGmCsCEjyEv"
            }
        }"#;
        let body: ReceiptBody = serde_json::from_str(json).unwrap();
        let action = body.action.unwrap();
        assert_eq!(action.signer_id, "sponsor.trezu.near");
        assert_eq!(action.actions.len(), 1);
    }

    #[test]
    fn test_deserialize_data_receipt() {
        // Data receipts have no Action field — should deserialize with action = None
        let json = r#"{"Data": {"data": null, "data_id": "abc123"}}"#;
        let body: ReceiptBody = serde_json::from_str(json).unwrap();
        assert!(body.action.is_none());
    }

    // ── Real block tests (live neardata calls) ────────────────────────────
    //
    // These tests call mainnet.neardata.xyz to fetch real block data for
    // webassemblymusic-treasury.sputnik-dao.near and verify that
    // fetch_account_block_data correctly extracts receipts, execution
    // outcomes, and the data needed for counterparty resolution.

    const DAO: &str = "webassemblymusic-treasury.sputnik-dao.near";

    fn neardata_client() -> NeardataClient {
        NeardataClient::from_env()
    }

    /// Block 188101233: Direct Transfer from petersalomonsen.near → DAO.
    /// Chunk receipt is an Action/Transfer.  Counterparty = predecessor_id.
    #[tokio::test]
    async fn test_block_188101233_transfer() {
        let result = neardata_client()
            .fetch_account_block_data(188_101_233, DAO)
            .await
            .unwrap();

        assert_eq!(result.block_height, 188_101_233);

        // Action receipt present → counterparty = predecessor_id
        assert_eq!(result.receipts.len(), 1);
        assert_eq!(
            result.receipts[0].receipt_id,
            "ENGjBrJUYWUKDfPKQZ1xCPX2AXax8F9m9sPA7nCj9TXK"
        );
        assert_eq!(result.receipts[0].predecessor_id, "petersalomonsen.near");
        assert_eq!(result.receipts[0].action_kind.as_deref(), Some("TRANSFER"));
        assert_eq!(result.receipts[0].signer_id, "petersalomonsen.near");
        assert_eq!(
            result.receipts[0].deposit.as_deref(),
            Some("432000000000000000000000")
        );

        // Execution outcome: no logs, no children
        assert!(
            result
                .execution_outcomes
                .iter()
                .all(|eo| eo.logs.is_empty())
        );
        let eo = result
            .execution_outcomes
            .iter()
            .find(|eo| eo.receipt_id == "ENGjBrJUYWUKDfPKQZ1xCPX2AXax8F9m9sPA7nCj9TXK")
            .expect("Missing execution outcome for receipt");
        assert_eq!(
            eo.tx_hash.as_deref(),
            Some("E2qj16xcmCcN9uFpxwBYkSLUxpYZ4yoSr4T9a7iRyds7")
        );
    }

    /// Block 188102293: FunctionCall (add_proposal) from petersalomonsen.near → DAO.
    /// Signer is sponsor.trezu.near (sponsored tx).  Counterparty = predecessor_id.
    #[tokio::test]
    async fn test_block_188102293_function_call() {
        let result = neardata_client()
            .fetch_account_block_data(188_102_293, DAO)
            .await
            .unwrap();

        assert_eq!(result.receipts.len(), 1);
        assert_eq!(result.receipts[0].predecessor_id, "petersalomonsen.near");
        assert_eq!(
            result.receipts[0].action_kind.as_deref(),
            Some("FUNCTION_CALL")
        );
        assert_eq!(
            result.receipts[0].method_name.as_deref(),
            Some("add_proposal")
        );
        // signer_id is the tx-level signer (sponsor), not the predecessor
        assert_eq!(result.receipts[0].signer_id, "sponsor.trezu.near");
    }

    /// Block 188102397: FunctionCall (act_proposal) from petersalomonsen.near → DAO.
    /// DAO executes and spawns 3 child receipts (intents call, callback, refund).
    /// Counterparty = predecessor_id.
    #[tokio::test]
    async fn test_block_188102397_act_proposal() {
        let result = neardata_client()
            .fetch_account_block_data(188_102_397, DAO)
            .await
            .unwrap();

        assert_eq!(result.receipts.len(), 1);
        assert_eq!(result.receipts[0].predecessor_id, "petersalomonsen.near");
        assert_eq!(
            result.receipts[0].action_kind.as_deref(),
            Some("FUNCTION_CALL")
        );
        assert_eq!(
            result.receipts[0].method_name.as_deref(),
            Some("act_proposal")
        );

        assert!(!result.execution_outcomes.is_empty());
        let eo = result
            .execution_outcomes
            .iter()
            .find(|eo| eo.receipt_id == "CuLGcwGqeRUS4Vt1SzgUV75prcjzZKXUfo5itdoysFqq")
            .expect("Missing execution outcome");
        // 3 child receipts: intents call, on_proposal_callback, sponsor refund
        assert_eq!(eo.receipt_ids.len(), 3);
        assert_eq!(
            eo.tx_hash.as_deref(),
            Some("9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U")
        );
    }

    /// Block 188102398: mt_burn on intents.near — logs mention DAO as owner_id.
    /// The mt_burn execution outcome is on intents.near, NOT the DAO.
    /// The DAO does have a chunk receipt here (5chj... self-callback waiting
    /// to execute at block 188102401), but no execution outcomes yet.
    #[tokio::test]
    async fn test_block_188102398_mt_burn_not_on_dao() {
        let result = neardata_client()
            .fetch_account_block_data(188_102_398, DAO)
            .await
            .unwrap();

        // The DAO has a pending self-callback receipt in the chunk, but the
        // mt_burn execution outcome belongs to intents.near, not the DAO.
        assert!(result.execution_outcomes.is_empty());
        // Chunk receipt 5chj... is the on_proposal_callback (self-call),
        // it will execute at block 188102401.
        if !result.receipts.is_empty() {
            assert_eq!(result.receipts[0].predecessor_id, DAO);
            assert_eq!(result.receipts[0].receiver_id, DAO);
        }
    }

    /// Block 188102398: verify mt_burn logs are captured when filtering for intents.near.
    #[tokio::test]
    async fn test_block_188102398_mt_burn_logs_on_intents() {
        let result = neardata_client()
            .fetch_account_block_data(188_102_398, "intents.near")
            .await
            .unwrap();

        let eo = result
            .execution_outcomes
            .iter()
            .find(|eo| eo.receipt_id == "4rpZjD77YaeE1fvNuPe9vjane4uaX7bBmQm1BYHoBWmP")
            .expect("Missing mt_burn execution outcome");
        assert_eq!(eo.logs.len(), 1);
        assert!(eo.logs[0].contains("mt_burn"));
        assert!(eo.logs[0].contains(DAO));
    }

    /// Block 188102401: Data receipt callback — DAO executes on_proposal_callback.
    /// No Action receipt in chunk (Data receipt from intents.near is filtered out).
    /// Execution outcome has tx_hash for tx_status fallback → counterparty =
    /// tx.receiver_id = petersalomonsen.near.
    #[tokio::test]
    async fn test_block_188102401_data_receipt_callback() {
        let result = neardata_client()
            .fetch_account_block_data(188_102_401, DAO)
            .await
            .unwrap();

        // Data receipt filtered out (no Action body) → receipts is empty
        assert!(
            result.receipts.is_empty(),
            "Data receipts should be filtered out"
        );

        // Execution outcome present with tx_hash for tx_status fallback
        let eo = result
            .execution_outcomes
            .iter()
            .find(|eo| eo.receipt_id == "5chj6XaVkHNy4s6o1eae9HFBE6XrhJ8BsrBzXUKbybKt")
            .expect("Missing execution outcome for on_proposal_callback");
        assert_eq!(
            eo.tx_hash.as_deref(),
            Some("9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U")
        );
        // Child receipts: Transfer to petersalomonsen.near + system refund to sponsor
        assert_eq!(eo.receipt_ids.len(), 2);
        assert!(eo.logs.is_empty());

        // tx_hash should be in transactions too
        assert!(
            result
                .transactions
                .iter()
                .any(|t| t.hash == "9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U")
        );
    }

    // ── Counterparty resolution tests ───────────────────────────────────────
    //
    // These tests verify the full counterparty resolution logic that the
    // gap filler uses: neardata for block data, tx_status for Data receipt
    // callbacks.  They assert counterparty, action_kind, and method_name
    // match what the Goldsky enrichment pipeline produces.

    /// Resolve counterparty from neardata block data, matching gap filler logic.
    /// Returns (counterparty, action_kind, method_name).
    async fn resolve_counterparty(
        block_height: u64,
        account_id: &str,
    ) -> (String, Option<String>, Option<String>) {
        let nd = neardata_client();
        let data = nd
            .fetch_account_block_data(block_height, account_id)
            .await
            .unwrap();

        if let Some(receipt) = data.receipts.first() {
            // Action receipt: counterparty = predecessor_id
            (
                receipt.predecessor_id.clone(),
                receipt.action_kind.clone(),
                receipt.method_name.clone(),
            )
        } else if let Some(eo) = data.execution_outcomes.first() {
            // Data receipt callback: use tx_status to get tx.receiver_id
            let tx_hash = eo
                .tx_hash
                .as_ref()
                .expect("execution outcome should have tx_hash");

            dotenvy::dotenv().ok();
            let api_key = std::env::var("FASTNEAR_API_KEY").expect("FASTNEAR_API_KEY must be set");
            let archival_rpc_url = std::env::var("NEAR_ARCHIVAL_RPC_URL")
                .unwrap_or_else(|_| "https://archival-rpc.mainnet.fastnear.com/".to_string());
            let network = near_api::NetworkConfig {
                rpc_endpoints: vec![
                    near_api::RPCEndpoint::new(archival_rpc_url.parse().unwrap())
                        .with_api_key(api_key),
                ],
                ..near_api::NetworkConfig::mainnet()
            };

            let tx_response = crate::handlers::balance_changes::block_info::get_transaction(
                &network, tx_hash, account_id,
            )
            .await
            .unwrap();

            let tx = match tx_response.final_execution_outcome.as_ref().unwrap() {
                near_primitives::views::FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(o) => {
                    &o.transaction
                }
                near_primitives::views::FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(o) => {
                    &o.final_outcome.transaction
                }
            };
            // Path C: tx.receiver_id is the economic counterparty
            (tx.receiver_id.to_string(), None, None)
        } else {
            panic!(
                "No receipts or execution outcomes for {} at block {}",
                account_id, block_height
            );
        }
    }

    /// Block 188101233: Transfer → counterparty = petersalomonsen.near
    #[tokio::test]
    async fn test_resolve_counterparty_188101233_transfer() {
        let (cp, action, method) = resolve_counterparty(188_101_233, DAO).await;
        assert_eq!(cp, "petersalomonsen.near");
        assert_eq!(action.as_deref(), Some("TRANSFER"));
        assert!(method.is_none());
    }

    /// Block 188102293: FunctionCall → counterparty = petersalomonsen.near
    #[tokio::test]
    async fn test_resolve_counterparty_188102293_function_call() {
        let (cp, action, method) = resolve_counterparty(188_102_293, DAO).await;
        assert_eq!(cp, "petersalomonsen.near");
        assert_eq!(action.as_deref(), Some("FUNCTION_CALL"));
        assert_eq!(method.as_deref(), Some("add_proposal"));
    }

    /// Block 188102397: FunctionCall (act_proposal) → counterparty = petersalomonsen.near
    #[tokio::test]
    async fn test_resolve_counterparty_188102397_act_proposal() {
        let (cp, action, method) = resolve_counterparty(188_102_397, DAO).await;
        assert_eq!(cp, "petersalomonsen.near");
        assert_eq!(action.as_deref(), Some("FUNCTION_CALL"));
        assert_eq!(method.as_deref(), Some("act_proposal"));
    }

    /// Block 188102401: Data receipt callback → tx_status → counterparty = petersalomonsen.near
    #[tokio::test]
    async fn test_resolve_counterparty_188102401_data_receipt_callback() {
        let (cp, action, method) = resolve_counterparty(188_102_401, DAO).await;
        assert_eq!(cp, "petersalomonsen.near");
        // Data receipt callback — no action_kind from chunk receipt
        assert!(action.is_none());
        assert!(method.is_none());
    }
}
