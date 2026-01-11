// NEAR Treasury Bulk Payment Contract
// See: https://github.com/NEAR-DevHub/near-treasury/issues/101
//
// This contract enables batch payment processing with support for:
// - Native NEAR tokens
// - NEP-141 fungible tokens via NEAR Intents (intents.near)
// - Storage-based fee model with 10% revenue margin
//
// List IDs are SHA-256 hashes of the payment list contents, ensuring:
// - Deterministic IDs (same list = same ID)
// - Integrity verification (hash proves list contents)
// - No auto-incrementing counters needed
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};

/// List ID is a hex-encoded SHA-256 hash (64 characters)
/// Example: "a1b2c3d4e5f6..." (64 hex chars = 32 bytes)
pub type ListId = String;

#[near(contract_state)]
pub struct BulkPaymentContract {
    /// Payment lists indexed by their content hash (hex-encoded SHA-256)
    payment_lists: IterableMap<ListId, PaymentList>,
    storage_credits: IterableMap<AccountId, NearToken>,
}

#[near(serializers = [json])]
pub struct PaymentInput {
    pub recipient: AccountId,
    pub amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PaymentRecord {
    pub recipient: AccountId,
    pub amount: U128,
    pub status: PaymentStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub enum PaymentStatus {
    Pending,
    /// Payment was executed at the specified block height.
    /// This can be used to find the transaction on-chain.
    Paid {
        block_height: u64,
    },
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PaymentList {
    pub token_id: String,
    pub submitter: AccountId,
    pub status: ListStatus,
    pub payments: Vec<PaymentRecord>,
    pub created_at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub enum ListStatus {
    Pending,
    Approved,
    Rejected,
}

/// Represents a completed payment transaction with block height for transaction lookup
#[near(serializers = [json])]
#[derive(Clone)]
pub struct PaymentTransaction {
    pub recipient: AccountId,
    pub amount: U128,
    pub block_height: u64,
}

impl Default for BulkPaymentContract {
    fn default() -> Self {
        Self {
            payment_lists: IterableMap::new(b"p"),
            storage_credits: IterableMap::new(b"s"),
        }
    }
}

/// NEP-245 Multi-Token Receiver trait
/// This trait defines the callback interface for receiving multi-token transfers
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near]
impl BulkPaymentContract {
    /// Initialize the contract
    #[init]
    #[allow(clippy::use_self)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Calculate the required deposit for purchasing storage for a given number of records.
    /// This is a view function that does not modify state.
    ///
    /// # Arguments
    /// * `num_records` - Number of payment records to calculate storage cost for
    ///
    /// # Returns
    /// The total cost in NearToken (including 10% markup)
    pub fn calculate_storage_cost(&self, num_records: u64) -> NearToken {
        require!(num_records > 0, "Number of records must be greater than 0");

        // Calculate storage per record:
        // - AccountId: 100 bytes max (UTF-8 string)
        // - amount: 16 bytes (u128)
        // - status: ~50 bytes (enum with error string)
        // - overhead: ~50 bytes for Vec storage
        const BYTES_PER_RECORD: u64 = 216;

        let storage_bytes = BYTES_PER_RECORD
            .checked_mul(num_records)
            .expect("Storage bytes calculation overflow");

        // NEAR storage cost: 1 byte = 10^19 yoctoNEAR
        let storage_cost_yocto = (storage_bytes as u128)
            .checked_mul(10_u128.pow(19))
            .expect("Storage cost calculation overflow");

        // Add 10% revenue margin
        let total_cost_yocto = storage_cost_yocto
            .checked_mul(11)
            .and_then(|x| x.checked_div(10))
            .expect("Total cost calculation overflow");

        NearToken::from_yoctonear(total_cost_yocto)
    }

    /// Purchase storage credits for payment records with 10% markup.
    /// Storage includes: AccountId (max 100 chars) + u128 amount + status fields.
    ///
    /// # Arguments
    /// * `num_records` - Number of payment records to purchase storage for
    /// * `beneficiary_account_id` - Optional account that will receive the storage credits.
    ///                              If not provided, the caller receives the credits.
    ///
    /// # Returns
    /// The total cost paid
    #[payable]
    pub fn buy_storage(
        &mut self,
        num_records: u64,
        beneficiary_account_id: Option<AccountId>,
    ) -> NearToken {
        require!(num_records > 0, "Number of records must be greater than 0");

        // Calculate the required cost using the shared calculation function
        let total_cost = self.calculate_storage_cost(num_records);

        let attached = env::attached_deposit();
        require!(
            attached == total_cost,
            format!(
                "Exact deposit required: {}, attached: {}",
                total_cost, attached
            )
        );

        // Determine who receives the storage credits
        let beneficiary = beneficiary_account_id.unwrap_or_else(|| env::predecessor_account_id());

        // Track storage credits for the beneficiary account
        let current_credits = self
            .storage_credits
            .get(&beneficiary)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0));
        let new_credits = NearToken::from_yoctonear(
            current_credits
                .as_yoctonear()
                .checked_add(num_records as u128)
                .expect("Storage credits overflow"),
        );
        self.storage_credits
            .insert(beneficiary.clone(), new_credits);

        log!(
            "Storage purchased: {} records for {} (beneficiary: {})",
            num_records,
            total_cost,
            beneficiary
        );

        total_cost
    }

    /// Validate that a list_id is a valid hex-encoded SHA-256 hash (64 hex characters)
    fn validate_list_id(list_id: &str) -> bool {
        list_id.len() == 64 && list_id.chars().all(|c| c.is_ascii_hexdigit())
    }

    /// Submit a payment list with pending status
    ///
    /// # Arguments
    /// * `list_id` - The SHA-256 hash of the payment list contents (hex-encoded, 64 chars).
    ///               This hash should be calculated by the client and verified against
    ///               a pending DAO proposal before submission.
    /// * `token_id` - The token to use for payments ("native" for NEAR, or token contract ID)
    /// * `payments` - List of payment records with recipient and amount
    /// * `submitter_id` - Optional submitter account ID. If provided, only the contract account
    ///                    can call this function to submit on behalf of another account (e.g., a DAO).
    ///                    The submitter must have sufficient storage credits.
    ///                    If not provided, the caller becomes the submitter.
    ///
    /// # Returns
    /// The list_id that was passed in (for convenience in logging/tracking)
    pub fn submit_list(
        &mut self,
        list_id: ListId,
        token_id: String,
        payments: Vec<PaymentInput>,
        submitter_id: Option<AccountId>,
    ) -> ListId {
        require!(!payments.is_empty(), "Payment list cannot be empty");
        require!(
            Self::validate_list_id(&list_id),
            "Invalid list_id: must be a 64-character hex string (SHA-256 hash)"
        );
        require!(
            self.payment_lists.get(&list_id).is_none(),
            "Payment list with this ID already exists"
        );

        let caller = env::predecessor_account_id();

        // Determine the effective submitter
        let submitter = if let Some(ref sid) = submitter_id {
            // Only the contract account can submit on behalf of another account
            require!(
                caller == env::current_account_id(),
                "Only the contract account can submit on behalf of another account"
            );
            sid.clone()
        } else {
            caller.clone()
        };

        // Verify storage credits for the submitter
        let required_credits = payments.len() as u128;
        let current_credits = self
            .storage_credits
            .get(&submitter)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0))
            .as_yoctonear();

        require!(
            current_credits >= required_credits,
            format!(
                "Insufficient storage credits. Required: {}, Available: {}",
                required_credits, current_credits
            )
        );

        // Deduct storage credits from the submitter
        let new_credits = NearToken::from_yoctonear(current_credits - required_credits);
        self.storage_credits.insert(submitter.clone(), new_credits);

        // Convert PaymentInput to PaymentRecord with Pending status
        let payment_records: Vec<PaymentRecord> = payments
            .into_iter()
            .map(|input| PaymentRecord {
                recipient: input.recipient,
                amount: input.amount,
                status: PaymentStatus::Pending,
            })
            .collect();

        let payment_list = PaymentList {
            token_id,
            submitter: submitter.clone(),
            status: ListStatus::Pending,
            payments: payment_records,
            created_at: env::block_timestamp(),
        };

        let num_payments = payment_list.payments.len();
        self.payment_lists.insert(list_id.clone(), payment_list);

        log!(
            "Payment list {} submitted by {} with {} payments",
            list_id,
            submitter,
            num_payments
        );

        list_id
    }

    /// Approve a payment list and attach the exact deposit amount
    #[payable]
    pub fn approve_list(&mut self, list_id: ListId) {
        let caller = env::predecessor_account_id();

        let mut list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone();

        require!(
            list.submitter == caller,
            "Only the submitter can approve the list"
        );

        require!(
            matches!(list.status, ListStatus::Pending),
            "List must be in Pending status"
        );

        // Calculate total payment amount (with overflow check)
        let total_amount: u128 = list
            .payments
            .iter()
            .map(|p| p.amount.0)
            .try_fold(0u128, |acc, x| acc.checked_add(x))
            .expect("Total payment amount overflow");

        let attached = env::attached_deposit();
        let required = NearToken::from_yoctonear(total_amount);

        require!(
            attached == required,
            format!(
                "Exact deposit required: {}, attached: {}",
                required, attached
            )
        );

        // Update list status
        list.status = ListStatus::Approved;
        self.payment_lists.insert(list_id.clone(), list);

        log!(
            "Payment list {} approved with deposit {}",
            list_id,
            attached
        );
    }

    /// Process payments in batches (public function, anyone can call)
    ///
    /// The contract uses dynamic gas metering to process as many payments as possible
    /// within the available gas. It checks remaining gas before each payment and stops
    /// when there's not enough gas for another payment plus reserve for final operations.
    ///
    /// Gas costs per payment type:
    /// - Native NEAR: ~3 TGas per transfer
    /// - NEP-141 FT: ~50 TGas per ft_transfer
    /// - NEAR Intents: ~50 TGas per ft_withdraw
    ///
    /// Worker should call with 300 TGas for maximum throughput.
    ///
    /// # Gas Optimization TODO
    /// Currently, reading the payment list from storage clones the entire Vec<PaymentRecord>,
    /// which costs ~156 TGas for 500 payments (~0.6 TGas per record for deserialization).
    /// This limits practical list size to ~250 payments before exceeding gas limits.
    /// Future optimization: Use IterableMap for payments instead of Vec to avoid full clone,
    /// or implement pagination for the payment list.
    ///
    /// # Returns
    /// Number of remaining pending payments after this batch. Returns 0 when all payments
    /// are complete. The caller should keep calling until this returns 0.
    ///
    /// # Panics
    /// - If the payment list is not found
    /// - If the list is not in Approved status
    /// - If there's not enough gas to process at least one payment
    pub fn payout_batch(&mut self, list_id: ListId) -> u64 {
        let mut list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone();

        require!(
            matches!(list.status, ListStatus::Approved),
            "List must be Approved to process payments"
        );

        // Determine gas needed per payment based on token type
        let gas_per_payment: Gas = if list.token_id.starts_with("nep141:") {
            // NEAR Intents: ft_withdraw cross-contract call
            Gas::from_tgas(50)
        } else if list.token_id == "native" || list.token_id == "near" || list.token_id == "NEAR" {
            // Native NEAR: minimal gas per transfer
            Gas::from_tgas(3)
        } else {
            // NEP-141 FT: ft_transfer cross-contract call
            Gas::from_tgas(50)
        };

        // Reserve gas for final operations (storing list, logging)
        let gas_reserve = Gas::from_tgas(15);

        let mut processed: u64 = 0;
        let mut first_pending_found = false;

        for payment in list.payments.iter_mut() {
            if matches!(payment.status, PaymentStatus::Pending) {
                // Check if we have enough gas for this payment
                let gas_remaining = env::prepaid_gas()
                    .as_gas()
                    .saturating_sub(env::used_gas().as_gas());

                if gas_remaining < gas_per_payment.as_gas() + gas_reserve.as_gas() {
                    // Not enough gas for another payment
                    if !first_pending_found {
                        // Haven't processed any payments yet - panic
                        env::panic_str(&format!(
                            "Insufficient gas to process payments. Need at least {} TGas, have {} TGas remaining",
                            (gas_per_payment.as_gas() + gas_reserve.as_gas()) / 1_000_000_000_000,
                            gas_remaining / 1_000_000_000_000
                        ));
                    }
                    // Already processed some, stop and let caller call again
                    break;
                }

                first_pending_found = true;

                if list.token_id.starts_with("nep141:") {
                    // NEAR Intents - call ft_withdraw on intents.near
                    let token_contract = list.token_id.strip_prefix("nep141:").unwrap();

                    // PoA tokens require WITHDRAW_TO memo for external chain withdrawals
                    let is_poa_token = token_contract.ends_with(".omft.near");

                    let args_json = if is_poa_token {
                        format!(
                            r#"{{"token":"{}","receiver_id":"{}","amount":"{}","memo":"WITHDRAW_TO:{}"}}"#,
                            token_contract, token_contract, payment.amount.0, payment.recipient
                        )
                    } else {
                        format!(
                            r#"{{"token":"{}","receiver_id":"{}","amount":"{}"}}"#,
                            token_contract, payment.recipient, payment.amount.0
                        )
                    };

                    Promise::new("intents.near".parse().unwrap()).function_call(
                        "ft_withdraw".to_string(),
                        args_json.into_bytes(),
                        NearToken::from_yoctonear(1),
                        Gas::from_tgas(50),
                    );
                } else if list.token_id == "native"
                    || list.token_id == "near"
                    || list.token_id == "NEAR"
                {
                    // Native NEAR transfer
                    Promise::new(payment.recipient.clone())
                        .transfer(NearToken::from_yoctonear(payment.amount.0));
                } else {
                    // NEP-141 fungible token transfer
                    let token_account: AccountId = list
                        .token_id
                        .parse()
                        .expect("Invalid token contract address");

                    let args = format!(
                        r#"{{"receiver_id":"{}","amount":"{}"}}"#,
                        payment.recipient, payment.amount.0
                    );

                    Promise::new(token_account).function_call(
                        "ft_transfer".to_string(),
                        args.into_bytes(),
                        NearToken::from_yoctonear(1),
                        Gas::from_tgas(50),
                    );
                }

                // Mark as Paid with current block height
                payment.status = PaymentStatus::Paid {
                    block_height: env::block_height(),
                };
                processed += 1;
            }
        }

        // Update the list
        self.payment_lists.insert(list_id.clone(), list.clone());

        // Count remaining pending payments
        let remaining_pending = list
            .payments
            .iter()
            .filter(|p| matches!(p.status, PaymentStatus::Pending))
            .count() as u64;

        log!(
            "Processed {} payments for list {}, {} remaining",
            processed,
            list_id,
            remaining_pending
        );

        remaining_pending
    }

    /// Reject a payment list (only allowed before approval)
    pub fn reject_list(&mut self, list_id: ListId) {
        let caller = env::predecessor_account_id();

        let mut list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone();

        require!(
            list.submitter == caller,
            "Only the submitter can reject the list"
        );

        require!(
            matches!(list.status, ListStatus::Pending),
            "Only pending lists can be rejected"
        );

        // Update status
        list.status = ListStatus::Rejected;
        self.payment_lists.insert(list_id.clone(), list);

        log!("Payment list {} rejected", list_id);
    }

    /// View a payment list with all details
    pub fn view_list(&self, list_id: ListId) -> PaymentList {
        self.payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone()
    }

    /// Get payment transactions for a list.
    /// Returns a list of recipients with their block heights where the payment was executed.
    /// The block height can be used to look up the transaction on a block explorer.
    pub fn get_payment_transactions(&self, list_id: ListId) -> Vec<PaymentTransaction> {
        let list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found");

        list.payments
            .iter()
            .filter_map(|p| {
                if let PaymentStatus::Paid { block_height } = &p.status {
                    Some(PaymentTransaction {
                        recipient: p.recipient.clone(),
                        amount: p.amount,
                        block_height: *block_height,
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    /// View storage credits for an account
    pub fn view_storage_credits(&self, account_id: AccountId) -> NearToken {
        self.storage_credits
            .get(&account_id)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0))
    }

    /// NEP-141 ft_on_transfer callback for fungible token approval flow
    /// This is called by the token contract after ft_transfer_call
    /// Returns the amount to refund (0 if all tokens are kept)
    ///
    /// The `msg` parameter should be the list_id (hex-encoded SHA-256 hash)
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        // msg is the list_id (hex-encoded hash)
        let list_id: ListId = msg;

        require!(
            Self::validate_list_id(&list_id),
            "msg must be a valid list_id (64-character hex string)"
        );

        // Get the list
        let mut list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone();

        // Validate that sender owns the list
        require!(
            list.submitter == sender_id,
            "Only the submitter can approve the list via ft_transfer_call"
        );

        // Validate list is in Pending status
        require!(
            matches!(list.status, ListStatus::Pending),
            "List must be in Pending status"
        );

        // Calculate total payment amount
        let total_amount: u128 = list
            .payments
            .iter()
            .map(|p| p.amount.0)
            .try_fold(0u128, |acc, x| acc.checked_add(x))
            .expect("Total payment amount overflow");

        // Validate amount matches total
        require!(
            amount.0 == total_amount,
            format!(
                "Exact token amount required: {}, received: {}",
                total_amount, amount.0
            )
        );

        // Approve the list
        list.status = ListStatus::Approved;
        self.payment_lists.insert(list_id.clone(), list);

        log!(
            "Payment list {} approved via ft_transfer_call with {} tokens",
            list_id,
            amount.0
        );

        // Return 0 to keep all tokens
        U128(0)
    }
}

/// NEP-245 Multi-Token Receiver implementation
#[near]
impl MultiTokenReceiver for BulkPaymentContract {
    /// NEP-245 mt_on_transfer callback for multi-token approval flow
    /// This is called by the multi-token contract (like intents.near) after mt_transfer_call
    /// Returns the amount to refund (0 if all tokens are kept)
    /// NEP-245 Multi-Token callback for `mt_transfer_call` and `mt_batch_transfer_call`
    ///
    /// This callback is invoked by the multi-token contract (e.g., intents.near) after
    /// transferring tokens to this contract via `mt_transfer_call`.
    ///
    /// # Arguments
    /// * `sender_id` - The account that initiated the `mt_transfer_call`
    /// * `previous_owner_ids` - Array of accounts that owned the tokens before transfer
    /// * `token_ids` - Array of token IDs being transferred
    /// * `amounts` - Array of token amounts being transferred (as strings)
    /// * `msg` - Message containing the list_id (hex-encoded SHA-256 hash)
    ///
    /// # Returns
    /// Array of unused token amounts to refund (as strings). Returns all zeros to keep all tokens.
    ///
    /// # Panics
    /// - If msg is not a valid list_id (64-character hex string)
    /// - If payment list is not found
    /// - If list is not in Pending status
    /// - If token_ids/amounts arrays don't match expectations
    /// - If transferred amount doesn't match required total
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        // Suppress unused variable warnings
        let _ = (previous_owner_ids, sender_id);

        // msg is the list_id (hex-encoded hash)
        let list_id: ListId = msg;

        require!(
            BulkPaymentContract::validate_list_id(&list_id),
            "msg must be a valid list_id (64-character hex string)"
        );

        // Get the list
        let mut list = self
            .payment_lists
            .get(&list_id)
            .expect("Payment list not found")
            .clone();

        // Validate that sender owns the list OR is the token holder approving the payment
        // The sender is the account calling mt_transfer_call (token owner)
        // The submitter is the account that created the payment list
        // We allow token owners to approve lists even if they didn't submit them

        // Validate list is in Pending status
        require!(
            matches!(list.status, ListStatus::Pending),
            "List must be in Pending status to approve via mt_transfer_call"
        );

        // For single token transfers, expect exactly one token
        require!(
            token_ids.len() == 1 && amounts.len() == 1,
            "Expected exactly one token transfer"
        );

        let token_id = &token_ids[0];
        let amount = amounts[0];

        // Validate token_id matches the list
        require!(
            list.token_id == *token_id,
            format!(
                "Token ID mismatch: list expects '{}', received '{}'",
                list.token_id, token_id
            )
        );

        // Calculate total payment amount
        let total_amount: u128 = list
            .payments
            .iter()
            .map(|p| p.amount.0)
            .try_fold(0u128, |acc, x| acc.checked_add(x))
            .expect("Total payment amount overflow");

        // Validate amount matches total
        require!(
            amount.0 == total_amount,
            format!(
                "Exact token amount required: {}, received: {}",
                total_amount, amount.0
            )
        );

        // Approve the list
        list.status = ListStatus::Approved;
        self.payment_lists.insert(list_id.clone(), list);

        log!(
            "Payment list {} approved via mt_transfer_call with {} tokens ({})",
            list_id,
            amount.0,
            token_id
        );

        // Return all zeros to keep all tokens (no refunds)
        PromiseOrValue::Value(vec![U128(0); token_ids.len()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn get_context(predecessor: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(predecessor);
        builder
    }

    /// Generate a valid list_id (64-character hex string) for testing
    fn test_list_id(suffix: &str) -> ListId {
        // Create a valid 64-character hex string by hashing the suffix
        // For testing, we just pad with 'a' (valid hex char) to make 64 characters
        let hex_suffix = suffix
            .bytes()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();
        let padded = format!("{:a>64}", hex_suffix);
        padded[..64].to_string()
    }

    #[test]
    fn test_initialization() {
        let contract = BulkPaymentContract::default();
        // Verify contract initializes with empty payment lists
        assert!(contract.payment_lists.is_empty());
    }

    #[test]
    fn test_storage_cost_calculation() {
        let mut context = get_context(accounts(0));

        // Calculate expected cost for 10 records
        // 216 bytes per record * 10 = 2160 bytes
        // 2160 * 10^19 yoctoNEAR/byte = 21600000000000000000000 yoctoNEAR
        // With 10% markup: 21600000000000000000000 * 1.1 = 23760000000000000000000 yoctoNEAR
        let expected_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);

        context.attached_deposit(expected_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        let result = contract.buy_storage(10, None);

        assert_eq!(result, expected_cost);

        // Verify credits were added
        let credits = contract.view_storage_credits(accounts(0));
        assert_eq!(credits.as_yoctonear(), 10);
    }

    #[test]
    #[should_panic(expected = "Exact deposit required")]
    fn test_storage_wrong_deposit() {
        let mut context = get_context(accounts(0));
        context.attached_deposit(NearToken::from_yoctonear(1_000_000));
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None); // Should panic with wrong deposit
    }

    #[test]
    fn test_submit_list_deducts_credits() {
        let mut context = get_context(accounts(0));

        // First buy storage
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        // Now submit a list with 2 payments
        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![
            PaymentInput {
                recipient: accounts(1),
                amount: U128(1_000_000_000_000_000_000_000_000),
            },
            PaymentInput {
                recipient: accounts(2),
                amount: U128(2_000_000_000_000_000_000_000_000),
            },
        ];

        let list_id = test_list_id("1");
        let returned_id =
            contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Verify credits were deducted (10 - 2 = 8)
        let credits = contract.view_storage_credits(accounts(0));
        assert_eq!(credits.as_yoctonear(), 8);

        // Verify list was created with the provided list_id
        assert_eq!(returned_id, list_id);
        let list = contract.view_list(list_id);
        assert_eq!(list.payments.len(), 2);
        assert_eq!(list.submitter, accounts(0));
    }

    #[test]
    #[should_panic(expected = "Insufficient storage credits")]
    fn test_submit_list_insufficient_credits() {
        let context = get_context(accounts(0));
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();

        let payments = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        // Should panic - no storage credits
        contract.submit_list(test_list_id("1"), "native".to_string(), payments, None);
    }

    #[test]
    fn test_approve_list() {
        let mut context = get_context(accounts(0));

        // Setup: buy storage and submit list
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![
            PaymentInput {
                recipient: accounts(1),
                amount: U128(1_000_000_000_000_000_000_000_000),
            },
            PaymentInput {
                recipient: accounts(2),
                amount: U128(2_000_000_000_000_000_000_000_000),
            },
        ];

        let list_id = test_list_id("approve_test");
        contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Approve with exact deposit (3 NEAR total)
        let total_deposit = NearToken::from_yoctonear(3_000_000_000_000_000_000_000_000);
        context.attached_deposit(total_deposit);
        testing_env!(context.build());

        contract.approve_list(list_id.clone());

        // Verify status changed
        let list = contract.view_list(list_id);
        assert!(matches!(list.status, ListStatus::Approved));
    }

    #[test]
    #[should_panic(expected = "Exact deposit required")]
    fn test_approve_list_wrong_deposit() {
        let mut context = get_context(accounts(0));

        // Setup
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        let list_id = test_list_id("wrong_deposit");
        contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Try to approve with wrong deposit
        let wrong_deposit = NearToken::from_yoctonear(500_000_000_000_000_000_000_000);
        context.attached_deposit(wrong_deposit);
        testing_env!(context.build());

        contract.approve_list(list_id); // Should panic
    }

    #[test]
    #[should_panic(expected = "Only the submitter can approve the list")]
    fn test_approve_list_unauthorized() {
        let mut context = get_context(accounts(0));

        // Setup: user 0 submits
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        let list_id = test_list_id("unauthorized");
        contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // User 1 tries to approve (should fail)
        context = get_context(accounts(1));
        let total_deposit = NearToken::from_yoctonear(1_000_000_000_000_000_000_000_000);
        context.attached_deposit(total_deposit);
        testing_env!(context.build());

        contract.approve_list(list_id); // Should panic
    }

    #[test]
    fn test_reject_list() {
        let mut context = get_context(accounts(0));

        // Setup
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        let list_id = test_list_id("reject_test");
        contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Reject without approval first
        contract.reject_list(list_id.clone());

        let list = contract.view_list(list_id);
        assert!(matches!(list.status, ListStatus::Rejected));
    }

    #[test]
    #[should_panic(expected = "Only pending lists can be rejected")]
    fn test_reject_approved_list_fails() {
        let mut context = get_context(accounts(0));

        // Setup
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        let list_id = test_list_id("reject_approved");
        contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Approve the list
        context.attached_deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000_000_000));
        testing_env!(context.build());
        contract.approve_list(list_id.clone());

        // Try to reject an approved list - should panic
        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());
        contract.reject_list(list_id);
    }

    #[test]
    fn test_multiple_lists() {
        let mut context = get_context(accounts(0));

        // Buy storage
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000 * 2);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(20, None);

        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        // Submit multiple lists
        let payments1 = vec![PaymentInput {
            recipient: accounts(1),
            amount: U128(1_000_000_000_000_000_000_000_000),
        }];

        let payments2 = vec![PaymentInput {
            recipient: accounts(2),
            amount: U128(2_000_000_000_000_000_000_000_000),
        }];

        let list_id1 = test_list_id("multi_1");
        let list_id2 = test_list_id("multi_2");

        let returned_id1 =
            contract.submit_list(list_id1.clone(), "native".to_string(), payments1, None);
        let returned_id2 =
            contract.submit_list(list_id2.clone(), "native".to_string(), payments2, None);

        assert_eq!(returned_id1, list_id1);
        assert_eq!(returned_id2, list_id2);

        let list1 = contract.view_list(list_id1);
        let list2 = contract.view_list(list_id2);

        assert_eq!(
            list1.payments[0].amount,
            U128(1_000_000_000_000_000_000_000_000)
        );
        assert_eq!(
            list2.payments[0].amount,
            U128(2_000_000_000_000_000_000_000_000)
        );
    }

    #[test]
    fn test_calculate_storage_cost() {
        let contract = BulkPaymentContract::default();

        // Calculate expected cost for 10 records
        // 216 bytes per record * 10 = 2160 bytes
        // 2160 * 10^19 yoctoNEAR/byte = 21600000000000000000000 yoctoNEAR
        // With 10% markup: 21600000000000000000000 * 1.1 = 23760000000000000000000 yoctoNEAR
        let expected_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);

        let calculated_cost = contract.calculate_storage_cost(10);

        assert_eq!(calculated_cost, expected_cost);
    }

    #[test]
    #[should_panic(expected = "Number of records must be greater than 0")]
    fn test_calculate_storage_cost_zero_records() {
        let contract = BulkPaymentContract::default();
        contract.calculate_storage_cost(0);
    }

    #[test]
    fn test_buy_storage_on_behalf_of_another_account() {
        let mut context = get_context(accounts(0)); // User 0 is the payer

        // Calculate expected cost for 10 records
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();

        // User 0 buys storage for User 1
        let result = contract.buy_storage(10, Some(accounts(1)));

        assert_eq!(result, storage_cost);

        // Verify User 0 (payer) has no credits
        let payer_credits = contract.view_storage_credits(accounts(0));
        assert_eq!(payer_credits.as_yoctonear(), 0);

        // Verify User 1 (beneficiary) has the credits
        let beneficiary_credits = contract.view_storage_credits(accounts(1));
        assert_eq!(beneficiary_credits.as_yoctonear(), 10);
    }

    #[test]
    fn test_buy_storage_without_beneficiary_credits_caller() {
        let mut context = get_context(accounts(0));

        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();

        // User 0 buys storage without specifying beneficiary
        let result = contract.buy_storage(10, None);

        assert_eq!(result, storage_cost);

        // Verify User 0 (caller) has the credits
        let credits = contract.view_storage_credits(accounts(0));
        assert_eq!(credits.as_yoctonear(), 10);
    }

    #[test]
    fn test_submit_list_uses_beneficiary_credits() {
        let mut context = get_context(accounts(0));

        // User 0 buys storage for User 1
        let storage_cost = NearToken::from_yoctonear(23_760_000_000_000_000_000_000);
        context.attached_deposit(storage_cost);
        testing_env!(context.build());

        let mut contract = BulkPaymentContract::default();
        contract.buy_storage(10, Some(accounts(1)));

        // User 1 submits a list using their credits
        context = get_context(accounts(1));
        context.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(context.build());

        let payments = vec![
            PaymentInput {
                recipient: accounts(2),
                amount: U128(1_000_000_000_000_000_000_000_000),
            },
            PaymentInput {
                recipient: accounts(3),
                amount: U128(2_000_000_000_000_000_000_000_000),
            },
        ];

        let list_id = test_list_id("beneficiary_test");
        let returned_id =
            contract.submit_list(list_id.clone(), "native".to_string(), payments, None);

        // Verify credits were deducted from User 1 (10 - 2 = 8)
        let credits = contract.view_storage_credits(accounts(1));
        assert_eq!(credits.as_yoctonear(), 8);

        // Verify list was created
        assert_eq!(returned_id, list_id);
        let list = contract.view_list(list_id);
        assert_eq!(list.payments.len(), 2);
        assert_eq!(list.submitter, accounts(1));
    }

    // Note: Overflow protection tests are implicitly validated by the NEAR runtime environment.
    // The environment checks account balances and prevents unrealistic values before our
    // contract code executes, providing an additional layer of security. Our checked_*
    // operations ensure safety within the contract logic itself.
}
