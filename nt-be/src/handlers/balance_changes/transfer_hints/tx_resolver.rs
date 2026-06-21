//! Transaction Status Resolver
//!
//! Uses `experimental_tx_status` to find exact blocks where balance changes occurred.
//! This eliminates the need for binary search when we have a transaction hash from hints.
//!
//! Also provides `resolve_receipt_to_transaction` which traces a receipt_id back to its
//! originating transaction hash using `EXPERIMENTAL_receipt` and block scanning.
//!
//! # How it works
//!
//! ## Transaction → Receipts (existing)
//! 1. Call `experimental_tx_status` with the transaction hash
//! 2. Get all receipt outcomes from the transaction
//! 3. Filter receipts where `executor_id` matches our account
//! 4. Resolve block heights from block hashes
//! 5. Return candidate blocks for balance verification
//!
//! ## Receipt → Transaction
//! 1. Call `EXPERIMENTAL_receipt` to get the receipt's on-chain `signer_id`
//! 2. Query `account_changes` on that signer to find `TransactionProcessing` entries
//! 3. For each candidate, call `EXPERIMENTAL_tx_status` to confirm it produced the receipt
//! 4. Return the matching transaction hash

use crate::handlers::balance_changes::utils::with_transport_retry;
use crate::utils::jsonrpc::create_rpc_client;
use near_api::NetworkConfig;
use near_jsonrpc_client::{JsonRpcClient, methods};
use near_jsonrpc_primitives::types::receipts::ReceiptReference;
use near_primitives::types::{BlockId, BlockReference};
use near_primitives::views::FinalExecutionOutcomeViewEnum;
use std::error::Error;

/// Transaction action metadata extracted from tx_status for storage in balance_changes.
#[derive(Debug, Clone)]
pub struct TxActionInfo {
    /// The first FunctionCall's method_name, if any
    pub method_name: Option<String>,
    /// High-level action kind string derived from the transaction's first action
    pub action_kind: Option<String>,
    /// Full serialized actions from the transaction (ActionView is Serialize)
    pub actions: serde_json::Value,
    /// The predecessor_id of the resolved receipt (the account that created it).
    /// For incoming transfers, this is the actual sender of funds.
    pub receipt_predecessor_id: Option<String>,
    /// For outgoing transfers: the executor_id of a child receipt created by this
    /// receipt, where that executor differs from the current account.
    /// This is the actual recipient of funds (e.g., the target DAO for Transfer actions).
    pub transfer_receiver_id: Option<String>,
}

/// Extract action info from a `FinalExecutionOutcomeView`.
///
/// For meta-transactions (Delegate), looks inside the delegate's inner actions
/// to find the actual FunctionCall method_name and action_kind.
fn extract_tx_action_info(
    outcome: &near_primitives::views::FinalExecutionOutcomeView,
) -> TxActionInfo {
    use near_primitives::views::ActionView;

    let actions = &outcome.transaction.actions;

    // Look for FunctionCall in top-level actions first, then inside Delegate
    let method_name = actions
        .iter()
        .find_map(|a| match a {
            ActionView::FunctionCall { method_name, .. } => Some(method_name.clone()),
            _ => None,
        })
        .or_else(|| {
            // Check inside Delegate actions (meta-transactions)
            actions.iter().find_map(|a| match a {
                ActionView::Delegate {
                    delegate_action, ..
                } => delegate_action.actions.iter().find_map(|inner| {
                    // NonDelegateAction wraps Action; check if it's FunctionCall
                    let action: near_primitives::action::Action = inner.clone().into();
                    match action {
                        near_primitives::action::Action::FunctionCall(fc) => Some(fc.method_name),
                        _ => None,
                    }
                }),
                _ => None,
            })
        });

    // Derive action_kind: for Delegate, use the inner action kind
    let action_kind = actions.first().map(|a| {
        match a {
            ActionView::CreateAccount => "CREATE_ACCOUNT",
            ActionView::DeployContract { .. } => "DEPLOY_CONTRACT",
            ActionView::FunctionCall { .. } => "FUNCTION_CALL",
            ActionView::Transfer { .. } => "TRANSFER",
            ActionView::Stake { .. } => "STAKE",
            ActionView::AddKey { .. } => "ADD_KEY",
            ActionView::DeleteKey { .. } => "DELETE_KEY",
            ActionView::DeleteAccount { .. } => "DELETE_ACCOUNT",
            ActionView::Delegate {
                delegate_action, ..
            } => {
                // Use the first inner action's kind for meta-transactions
                delegate_action
                    .actions
                    .first()
                    .map(|inner| {
                        let action: near_primitives::action::Action = inner.clone().into();
                        match action {
                            near_primitives::action::Action::FunctionCall(_) => "FUNCTION_CALL",
                            near_primitives::action::Action::Transfer(_) => "TRANSFER",
                            near_primitives::action::Action::CreateAccount(_) => "CREATE_ACCOUNT",
                            _ => "DELEGATE",
                        }
                    })
                    .unwrap_or("DELEGATE")
            }
            _ => "UNKNOWN",
        }
        .to_string()
    });

    let actions_json = serde_json::to_value(actions).unwrap_or(serde_json::json!([]));

    TxActionInfo {
        method_name,
        action_kind,
        actions: actions_json,
        receipt_predecessor_id: None, // populated later from receipt data
        transfer_receiver_id: None,   // populated later from child receipts
    }
}

/// Result of resolving a transaction to find balance change blocks
#[derive(Debug, Clone)]
pub struct ResolvedTransaction {
    /// Transaction hash that was resolved
    pub transaction_hash: String,
    /// Blocks where receipts executed on the target account
    pub receipt_blocks: Vec<ReceiptBlock>,
}

/// A receipt execution block
#[derive(Debug, Clone)]
pub struct ReceiptBlock {
    /// Block height where receipt executed
    pub block_height: u64,
    /// Receipt ID
    pub receipt_id: String,
    /// Account that executed the receipt
    pub executor_id: String,
    /// Whether a balance change was confirmed at this block (via EXPERIMENTAL_changes)
    pub balance_changed: Option<bool>,
}

/// Resolve a transaction hash to find blocks where an account's balance changed
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `tx_hash` - Transaction hash to resolve
/// * `account_id` - Account to find balance changes for
/// * `sender_account_id` - Account ID to use for tx lookup (usually the signer or receiver)
///
/// # Returns
/// ResolvedTransaction with all blocks where the account had receipts executed
pub async fn resolve_transaction_blocks(
    network: &NetworkConfig,
    tx_hash: &str,
    account_id: &str,
    sender_account_id: &str,
) -> Result<ResolvedTransaction, Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    // Parse inputs once (deterministic, no need to retry)
    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    // Query transaction status with retry on transport errors
    let tx_response = with_transport_retry("tx_status", || {
        let req = methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await?;

    let mut receipt_blocks = Vec::new();

    // Extract receipt outcomes
    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Err("No final execution outcome in transaction".into()),
    };

    // Find receipts that executed on our account
    for receipt_outcome in receipts_outcome {
        let executor = receipt_outcome.outcome.executor_id.as_str();

        if executor == account_id {
            let block_hash = receipt_outcome.block_hash.to_string();

            // Resolve block height from block hash with retry on transport errors
            let parsed_block_hash: near_primitives::hash::CryptoHash = block_hash.parse()?;
            let block = with_transport_retry("block", || {
                let req = methods::block::RpcBlockRequest {
                    block_reference: BlockReference::BlockId(BlockId::Hash(parsed_block_hash)),
                };
                client.call(req)
            })
            .await?;
            let block_height = block.header.height;

            receipt_blocks.push(ReceiptBlock {
                block_height,
                receipt_id: receipt_outcome.id.to_string(),
                executor_id: executor.to_string(),
                balance_changed: None, // Will be verified later if needed
            });
        }
    }

    Ok(ResolvedTransaction {
        transaction_hash: tx_hash.to_string(),
        receipt_blocks,
    })
}

/// Resolve a transaction to get ALL unique receipt block heights, sorted ascending.
///
/// Unlike `resolve_transaction_blocks`, this does not filter by executor_id.
/// Returns every unique block height where any receipt in the transaction executed.
/// The caller should check balance at each block to find where the actual change occurred.
pub async fn resolve_all_receipt_block_heights(
    network: &NetworkConfig,
    tx_hash: &str,
    sender_account_id: &str,
) -> Result<Vec<u64>, Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    let tx_response = with_transport_retry("tx_status_all_receipts", || {
        let req = methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await?;

    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Err("No final execution outcome in transaction".into()),
    };

    // Collect unique block hashes
    let mut unique_block_hashes: Vec<near_primitives::hash::CryptoHash> = Vec::new();
    for ro in receipts_outcome {
        if !unique_block_hashes.contains(&ro.block_hash) {
            unique_block_hashes.push(ro.block_hash);
        }
    }

    // Resolve each unique block hash to height
    let mut heights = Vec::new();
    for block_hash in unique_block_hashes {
        let block = with_transport_retry("block_for_receipt", || {
            let req = methods::block::RpcBlockRequest {
                block_reference: BlockReference::BlockId(BlockId::Hash(block_hash)),
            };
            client.call(req)
        })
        .await?;
        heights.push(block.header.height);
    }

    heights.sort();
    heights.dedup();
    Ok(heights)
}

/// Resolve the exact block height for a specific receipt within a transaction.
///
/// Calls `EXPERIMENTAL_tx_status` once, finds the receipt matching `receipt_id`,
/// and resolves its block hash to a height. Returns `None` if the receipt ID is
/// not found.
///
/// * `resolve_counterparty` - When true, inspects receipt predecessors and child
///   receipts from the `EXPERIMENTAL_tx_status` response to infer a more accurate
///   counterparty for native NEAR events. No additional RPC calls are made.
pub async fn resolve_receipt_block_height(
    network: &NetworkConfig,
    tx_hash: &str,
    sender_account_id: &str,
    receipt_id: &str,
    resolve_counterparty: bool,
) -> Result<(Option<u64>, Option<TxActionInfo>), Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    // Use EXPERIMENTAL_tx_status which returns full ReceiptView objects
    // (including predecessor_id) — avoids a separate EXPERIMENTAL_receipt call.
    let tx_response = with_transport_retry("tx_status", || {
        let req = methods::EXPERIMENTAL_tx_status::RpcTransactionStatusRequest {
            transaction_info: methods::EXPERIMENTAL_tx_status::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await?;

    let (receipts_outcome, mut tx_action_info, receipts) =
        match &tx_response.final_execution_outcome {
            Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => (
                &outcome.receipts_outcome,
                Some(extract_tx_action_info(outcome)),
                None,
            ),
            Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => (
                &outcome.final_outcome.receipts_outcome,
                Some(extract_tx_action_info(&outcome.final_outcome)),
                Some(&outcome.receipts),
            ),
            None => return Err("No final execution outcome in transaction".into()),
        };

    // Parse receipt_id once to avoid per-iteration string allocations.
    let parsed_receipt_id: near_primitives::hash::CryptoHash = receipt_id.parse()?;

    // Find our receipt in receipts_outcome first — if it's not there,
    // return early.
    let our_receipt = match receipts_outcome
        .iter()
        .find(|ro| ro.id == parsed_receipt_id)
    {
        Some(ro) => ro,
        None => return Ok((None, tx_action_info)),
    };

    // Resolve receipt-level counterparty data (predecessor + child receipts).
    // This is opt-in: only enabled for native NEAR events where transaction-level
    // signer/receiver is unreliable.
    if resolve_counterparty && let Some(info) = &mut tx_action_info {
        // Predecessor: extract from the full receipt data returned by
        // EXPERIMENTAL_tx_status (no extra RPC call needed).
        if let Some(receipts) = receipts
            && let Some(receipt) = receipts.iter().find(|r| r.receipt_id == parsed_receipt_id)
        {
            let predecessor = receipt.predecessor_id.to_string();
            tracing::debug!("receipt {} predecessor_id={}", receipt_id, predecessor);
            info.receipt_predecessor_id = Some(predecessor);
        }

        // Child receipts: find a child whose executor_id differs from ours.
        // That executor is the transfer recipient (for outgoing transfers).
        let our_executor = our_receipt.outcome.executor_id.as_str();
        let child_ids: std::collections::HashSet<near_primitives::hash::CryptoHash> =
            our_receipt.outcome.receipt_ids.iter().cloned().collect();

        if let Some(child) = receipts_outcome.iter().find(|ro| {
            child_ids.contains(&ro.id) && ro.outcome.executor_id.as_str() != our_executor
        }) {
            let receiver = child.outcome.executor_id.to_string();
            tracing::debug!("receipt {} has child receipt on {}", receipt_id, receiver);
            info.transfer_receiver_id = Some(receiver);
        }
    }

    let block_hash = our_receipt.block_hash;

    let block = with_transport_retry("block_for_receipt", || {
        let req = methods::block::RpcBlockRequest {
            block_reference: BlockReference::BlockId(BlockId::Hash(block_hash)),
        };
        client.call(req)
    })
    .await?;

    Ok((Some(block.header.height), tx_action_info))
}

/// Find candidate blocks where a balance change may have occurred using tx_status
///
/// This is the main entry point for hint resolution. Given a transaction hash,
/// it finds all blocks where receipts executed on the account. The caller should
/// verify actual balance changes by comparing balances before and after each block.
///
/// Note: This returns candidate blocks only. For FT/intents tokens, balance changes
/// happen on the token contract, not on the account itself, so the caller must
/// use `get_balance_at_block` to verify actual balance changes.
///
/// # Arguments
/// * `network` - NEAR network configuration
/// * `tx_hash` - Transaction hash from the hint
/// * `account_id` - Account we're tracking
///
/// # Returns
/// Vector of block heights where receipts executed on the account, sorted ascending
pub async fn find_balance_change_blocks(
    network: &NetworkConfig,
    tx_hash: &str,
    account_id: &str,
) -> Result<Vec<u64>, Box<dyn Error + Send + Sync>> {
    // Try resolving with the account as sender
    let resolved = match resolve_transaction_blocks(network, tx_hash, account_id, account_id).await
    {
        Ok(r) => r,
        Err(_) => {
            // Transaction might have been sent by someone else, try a generic lookup
            // In this case, we'll just return empty and let the caller handle it
            tracing::debug!(
                "Could not resolve tx {} with account {} as sender",
                tx_hash,
                account_id
            );
            return Ok(vec![]);
        }
    };

    if resolved.receipt_blocks.is_empty() {
        return Ok(vec![]);
    }

    let mut result_blocks: Vec<u64> = resolved
        .receipt_blocks
        .iter()
        .map(|rb| rb.block_height)
        .collect();

    result_blocks.sort();
    result_blocks.dedup();

    Ok(result_blocks)
}

/// Result of resolving a receipt to its originating transaction
#[derive(Debug, Clone)]
pub struct ReceiptTransaction {
    /// The receipt ID that was resolved
    pub receipt_id: String,
    /// The originating transaction hash
    pub transaction_hash: String,
    /// The signer of the originating transaction
    pub signer_id: String,
}

/// Resolve a receipt_id to its originating transaction hash
///
/// 1. Calls `EXPERIMENTAL_receipt` to get the receipt's on-chain `signer_id`
/// 2. Queries `account_changes` on that signer to find `TransactionProcessing` entries
/// 3. Confirms with `EXPERIMENTAL_tx_status` which transaction produced the receipt
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `receipt_id` - The receipt ID to resolve
/// * `block_height` - The block height where this receipt was executed
///
/// # Returns
/// `ReceiptTransaction` containing the originating transaction hash
pub async fn resolve_receipt_to_transaction(
    network: &NetworkConfig,
    receipt_id: &str,
    block_height: u64,
) -> Result<ReceiptTransaction, Box<dyn Error + Send + Sync>> {
    let client = create_rpc_client(network)?;

    // Step 1: Fetch receipt to get the on-chain signer_id
    let parsed_receipt_id: near_primitives::hash::CryptoHash = receipt_id.parse()?;
    let receipt_response = with_transport_retry("receipt_for_tx_resolve", || {
        let req = methods::EXPERIMENTAL_receipt::RpcReceiptRequest {
            receipt_reference: ReceiptReference {
                receipt_id: parsed_receipt_id,
            },
        };
        client.call(req)
    })
    .await?;

    // For Action receipts, use signer_id directly and search for this receipt.
    // For Data receipts, find the action receipt that caused the balance change,
    // then search for that receipt instead (data receipts don't appear in tx outcomes).
    let (search_receipt_id, signer_id) = match &receipt_response.receipt {
        near_primitives::views::ReceiptEnumView::Action { signer_id, .. } => {
            (receipt_id.to_string(), signer_id.to_string())
        }
        _ => {
            let receiver = receipt_response.receiver_id.to_string();
            find_action_receipt_at_block(&client, &receiver, block_height).await?
        }
    };

    let parsed_signer: near_primitives::types::AccountId = signer_id.parse()?;

    tracing::debug!(
        "Resolving receipt {} to transaction via account_changes on {} near block {}",
        receipt_id,
        signer_id,
        block_height
    );

    // Step 2: Search for TransactionProcessing on the signer's account.
    // The transaction is included at or before the receipt execution block.
    let mut result = find_transaction_on_signer(
        &client,
        &search_receipt_id,
        &signer_id,
        &parsed_signer,
        block_height,
    )
    .await?;

    // Return the original receipt_id in the result
    result.receipt_id = receipt_id.to_string();
    Ok(result)
}

/// For a Data receipt, find the Action receipt that caused the balance change at this block
///
/// Returns (action_receipt_id, signer_id) — the action receipt can be looked up in tx outcomes
/// (data receipts don't appear in `receipts_outcome`).
async fn find_action_receipt_at_block(
    client: &JsonRpcClient,
    receiver: &str,
    block_height: u64,
) -> Result<(String, String), Box<dyn Error + Send + Sync>> {
    let parsed_receiver: near_primitives::types::AccountId = receiver.parse()?;

    let changes_response = with_transport_retry("account_changes_for_data_receipt", || {
        let req = methods::EXPERIMENTAL_changes::RpcStateChangesInBlockByTypeRequest {
            block_reference: BlockReference::BlockId(BlockId::Height(block_height)),
            state_changes_request:
                near_primitives::views::StateChangesRequestView::AccountChanges {
                    account_ids: vec![parsed_receiver.clone()],
                },
        };
        client.call(req)
    })
    .await?;

    // Find receipt hashes from receipt_processing causes — these are the action receipts
    use near_primitives::views::StateChangeCauseView;
    let mut seen = Vec::new();
    for change in &changes_response.changes {
        if let StateChangeCauseView::ReceiptProcessing { receipt_hash } = &change.cause {
            let hash_str = receipt_hash.to_string();
            if seen.contains(&hash_str) {
                continue;
            }
            seen.push(hash_str);

            // Fetch this receipt to get its signer_id
            let receipt_response = with_transport_retry("receipt_for_data_receipt_signer", || {
                let req = methods::EXPERIMENTAL_receipt::RpcReceiptRequest {
                    receipt_reference: ReceiptReference {
                        receipt_id: *receipt_hash,
                    },
                };
                client.call(req)
            })
            .await?;

            if let near_primitives::views::ReceiptEnumView::Action { signer_id, .. } =
                &receipt_response.receipt
            {
                return Ok((receipt_hash.to_string(), signer_id.to_string()));
            }
        }
    }

    Err(format!(
        "Could not find action receipt for data receipt at block {} on {}",
        block_height, receiver
    )
    .into())
}

/// Search for TransactionProcessing on a signer's account to find the originating transaction
async fn find_transaction_on_signer(
    client: &JsonRpcClient,
    receipt_id: &str,
    signer_id: &str,
    parsed_signer: &near_primitives::types::AccountId,
    block_height: u64,
) -> Result<ReceiptTransaction, Box<dyn Error + Send + Sync>> {
    let search_start = block_height.saturating_sub(5);

    for search_block in (search_start..=block_height).rev() {
        let changes_response = match with_transport_retry("account_changes_for_tx", || {
            let req = methods::EXPERIMENTAL_changes::RpcStateChangesInBlockByTypeRequest {
                block_reference: BlockReference::BlockId(BlockId::Height(search_block)),
                state_changes_request:
                    near_primitives::views::StateChangesRequestView::AccountChanges {
                        account_ids: vec![parsed_signer.clone()],
                    },
            };
            client.call(req)
        })
        .await
        {
            Ok(resp) => resp,
            Err(e) => {
                tracing::debug!(
                    "account_changes on {} at block {} failed: {}",
                    signer_id,
                    search_block,
                    e
                );
                continue;
            }
        };

        // Collect unique transaction_processing tx hashes
        let mut tx_hashes = Vec::new();
        for change in &changes_response.changes {
            use near_primitives::views::StateChangeCauseView;
            if let StateChangeCauseView::TransactionProcessing { tx_hash } = &change.cause {
                let hash_str = tx_hash.to_string();
                if !tx_hashes.contains(&hash_str) {
                    tx_hashes.push(hash_str);
                }
            }
        }

        if tx_hashes.is_empty() {
            continue;
        }

        tracing::debug!(
            "Found {} candidate tx hash(es) at block {} on {}: {:?}",
            tx_hashes.len(),
            search_block,
            signer_id,
            tx_hashes
        );

        // Confirm which transaction produced our receipt
        for tx_hash in &tx_hashes {
            match has_receipt(client, tx_hash, signer_id, receipt_id).await {
                Ok(true) => {
                    tracing::debug!(
                        "Resolved receipt {} to transaction {} (via account_changes on {} at block {})",
                        receipt_id,
                        tx_hash,
                        signer_id,
                        search_block
                    );
                    return Ok(ReceiptTransaction {
                        receipt_id: receipt_id.to_string(),
                        transaction_hash: tx_hash.clone(),
                        signer_id: signer_id.to_string(),
                    });
                }
                Ok(false) => continue,
                Err(e) => {
                    tracing::debug!(
                        "Error checking tx {} for receipt {}: {}",
                        tx_hash,
                        receipt_id,
                        e
                    );
                    continue;
                }
            }
        }
    }

    Err(format!(
        "Could not find originating transaction for receipt {} (signer={}, block={})",
        receipt_id, signer_id, block_height
    )
    .into())
}

/// Check if a transaction produced a specific receipt
async fn has_receipt(
    client: &JsonRpcClient,
    tx_hash: &str,
    sender_account_id: &str,
    target_receipt_id: &str,
) -> Result<bool, Box<dyn Error + Send + Sync>> {
    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    let tx_response = with_transport_retry("has_receipt_tx_status", || {
        let req = methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        client.call(req)
    })
    .await?;

    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Ok(false),
    };

    Ok(receipts_outcome
        .iter()
        .any(|r| r.id.to_string() == target_receipt_id))
}

/// Resolve a receipt_id to its originating transaction hash using all receipt outcomes
///
/// This is a higher-level function that resolves a transaction and returns all receipt-to-tx
/// mappings. Useful for batch resolution of multiple receipts from the same transaction.
///
/// # Arguments
/// * `network` - NEAR network configuration (archival RPC)
/// * `tx_hash` - Known transaction hash
/// * `sender_account_id` - The transaction signer
///
/// # Returns
/// Map of receipt_id → transaction_hash for all receipts in this transaction
pub async fn get_all_receipt_tx_mappings(
    network: &NetworkConfig,
    tx_hash: &str,
    sender_account_id: &str,
) -> Result<Vec<(String, String)>, Box<dyn Error + Send + Sync>> {
    // Parse inputs once (deterministic, no need to retry)
    let parsed_tx_hash: near_primitives::hash::CryptoHash = tx_hash.parse()?;
    let parsed_sender: near_primitives::types::AccountId = sender_account_id.parse()?;

    // Query transaction status with retry on transport errors
    let tx_response = with_transport_retry("tx_status_for_receipts", || {
        let client = create_rpc_client(network).unwrap();
        let request = methods::tx::RpcTransactionStatusRequest {
            transaction_info: methods::tx::TransactionInfo::TransactionId {
                tx_hash: parsed_tx_hash,
                sender_account_id: parsed_sender.clone(),
            },
            wait_until: near_primitives::views::TxExecutionStatus::Final,
        };
        async move { client.call(request).await }
    })
    .await?;

    let receipts_outcome = match &tx_response.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(outcome)) => {
            &outcome.receipts_outcome
        }
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(outcome)) => {
            &outcome.final_outcome.receipts_outcome
        }
        None => return Ok(vec![]),
    };

    Ok(receipts_outcome
        .iter()
        .map(|r| (r.id.to_string(), tx_hash.to_string()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_utils::init_test_state;

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_outgoing_near_transfer() {
        let state = init_test_state().await;

        // Transaction CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5
        // This has the -0.1 NEAR outgoing transfer
        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let account = "webassemblymusic-treasury.sputnik-dao.near";

        let resolved =
            resolve_transaction_blocks(&state.archival_network, tx_hash, account, account)
                .await
                .expect("Should resolve transaction");

        println!("Resolved transaction: {:?}", resolved);

        // Assert transaction hash
        assert_eq!(
            resolved.transaction_hash, tx_hash,
            "Transaction hash should match"
        );

        // Assert we have exactly 2 receipt blocks
        assert_eq!(
            resolved.receipt_blocks.len(),
            2,
            "Should have exactly 2 receipt blocks"
        );

        // Assert first receipt block properties
        assert_eq!(resolved.receipt_blocks[0].block_height, 178148635);
        assert_eq!(
            resolved.receipt_blocks[0].receipt_id,
            "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1"
        );
        assert_eq!(resolved.receipt_blocks[0].executor_id, account);
        assert_eq!(resolved.receipt_blocks[0].balance_changed, None);

        // Assert second receipt block properties
        assert_eq!(resolved.receipt_blocks[1].block_height, 178148637);
        assert_eq!(
            resolved.receipt_blocks[1].receipt_id,
            "9VZewnkJcDPFvxgASNKas17DC1u8fhkPaCfVNuZdCZjq"
        );
        assert_eq!(resolved.receipt_blocks[1].executor_id, account);
        assert_eq!(resolved.receipt_blocks[1].balance_changed, None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_balance_change_blocks() {
        let state = init_test_state().await;

        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let account = "webassemblymusic-treasury.sputnik-dao.near";

        let blocks = find_balance_change_blocks(&state.archival_network, tx_hash, account)
            .await
            .expect("Should find candidate blocks");

        println!("Candidate blocks: {:?}", blocks);

        // Should find exactly 2 blocks (sorted and deduped)
        assert_eq!(blocks.len(), 2, "Should have exactly 2 candidate blocks");

        // Blocks should be sorted ascending
        assert_eq!(blocks[0], 178148635);
        assert_eq!(blocks[1], 178148637);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_receipt_to_transaction() {
        let state = init_test_state().await;

        // Receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1 is part of
        // transaction CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5
        // signed by petersalomonsen.near (who called act_proposal on the DAO), executed at block 178148635
        let receipt_id = "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1";
        let block_height = 178148635;

        let result =
            resolve_receipt_to_transaction(&state.archival_network, receipt_id, block_height)
                .await
                .expect("Should resolve receipt to transaction");

        println!("Resolved receipt: {:?}", result);

        assert_eq!(result.receipt_id, receipt_id, "Receipt ID should match");
        assert_eq!(
            result.transaction_hash, "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5",
            "Should resolve to the correct originating transaction"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_meta_transaction_receipt() {
        let state = init_test_state().await;

        // Receipt 2nLMJS4s43ou8sXjNL84y4Vxnnt5tRKK8nomsxthrwfi is a meta-transaction
        // signed by treasury-factory.near (relayer) on behalf of olskik.near
        let receipt_id = "2nLMJS4s43ou8sXjNL84y4Vxnnt5tRKK8nomsxthrwfi";
        let block_height = 185258323;

        let result =
            resolve_receipt_to_transaction(&state.archival_network, receipt_id, block_height)
                .await
                .expect("Should resolve meta-transaction receipt");

        println!("Resolved meta-tx receipt: {:?}", result);

        assert_eq!(result.receipt_id, receipt_id);
        assert_eq!(
            result.signer_id, "treasury-factory.near",
            "Signer should be the relayer (treasury-factory.near), not the user"
        );
        assert!(
            !result.transaction_hash.is_empty(),
            "Should resolve to a transaction hash"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_data_receipt_wrap_near() {
        let state = init_test_state().await;

        // Receipt 5JeCG66x51314NzRXzky8kRqS5bXwBGWxJmLXFw4xieh is a Data receipt
        // from wrap.near to testing-astradao.sputnik-dao.near at block 185175857.
        // The actual action receipt (on_proposal_callback) was signed by megha19.near,
        // originating from tx 3NV19q2Gnef1rAdeDa6HA6PxwXwJzv4aAm4s61rkSNCC at block 185175854.
        let receipt_id = "5JeCG66x51314NzRXzky8kRqS5bXwBGWxJmLXFw4xieh";
        let block_height = 185175857;

        let result =
            resolve_receipt_to_transaction(&state.archival_network, receipt_id, block_height)
                .await
                .expect("Should resolve data receipt");

        println!("Resolved data receipt: {:?}", result);

        assert_eq!(result.receipt_id, receipt_id);
        assert_eq!(
            result.signer_id, "megha19.near",
            "Signer should be megha19.near who called act_proposal"
        );
        assert_eq!(
            result.transaction_hash, "3NV19q2Gnef1rAdeDa6HA6PxwXwJzv4aAm4s61rkSNCC",
            "Should resolve to the correct originating transaction"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_all_receipt_tx_mappings() {
        let state = init_test_state().await;

        let tx_hash = "CpctEH17tQgvAT6kTPkCpWtSGtG4WFYS2Urjq9eNNhm5";
        let sender = "webassemblymusic-treasury.sputnik-dao.near";

        let mappings = get_all_receipt_tx_mappings(&state.archival_network, tx_hash, sender)
            .await
            .expect("Should get receipt-tx mappings");

        println!("Receipt-TX mappings: {:?}", mappings);

        assert!(
            !mappings.is_empty(),
            "Should have at least one receipt mapping"
        );

        // All mappings should point to the same transaction
        for (receipt_id, mapped_tx_hash) in &mappings {
            assert_eq!(
                mapped_tx_hash, tx_hash,
                "Receipt {} should map to transaction {}",
                receipt_id, tx_hash
            );
        }

        // Should contain the known receipt
        let has_known_receipt = mappings
            .iter()
            .any(|(r, _)| r == "4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1");
        assert!(
            has_known_receipt,
            "Should contain the known receipt 4k8fzeY5VkQmRsseapsPBA2mNReroXdjQVpvHkhWURt1"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_resolve_all_receipt_block_heights_intents_swap() {
        let state = init_test_state().await;

        // Transaction 9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U
        // act_proposal on webassemblymusic-treasury.sputnik-dao.near
        // triggering an intents swap (ft_withdraw → mt_burn → ft_transfer → ft_resolve_withdraw)
        // Signer: sponsor.trezu.near
        // 11 receipts across 7 unique blocks
        let tx_hash = "9noKHxN7Rj7tNhZVfZZbCRu1ZiWSq8cqDr9RAwX1TL7U";
        let sender = "sponsor.trezu.near";

        let blocks = resolve_all_receipt_block_heights(&state.archival_network, tx_hash, sender)
            .await
            .expect("Should resolve all receipt block heights");

        println!("All receipt block heights: {:?}", blocks);

        // Should be sorted ascending and deduped
        assert!(
            blocks.windows(2).all(|w| w[0] < w[1]),
            "Blocks should be sorted ascending with no duplicates"
        );

        // This transaction has receipts across 7 unique blocks
        assert_eq!(blocks.len(), 7, "Expected 7 unique receipt blocks");

        // Key blocks where webassemblymusic-treasury balance changes:
        //   188102397: NEAR balance change (gas cost)
        //   188102398: intents USDC balance change (mt_burn)
        assert!(
            blocks.contains(&188102397),
            "Should contain block 188102397 (NEAR balance change)"
        );
        assert!(
            blocks.contains(&188102398),
            "Should contain block 188102398 (intents USDC mt_burn)"
        );
    }
}
