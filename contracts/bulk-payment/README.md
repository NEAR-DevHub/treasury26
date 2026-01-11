# NEAR Treasury Bulk Payment Contract

A NEAR smart contract for batch payment processing with DAO integration.

## Features

- **Batch Payments**: Process up to 100 payments per batch with dynamic gas metering
- **Multiple Token Types**: Support for native NEAR, NEP-141 fungible tokens, and NEAR Intents
- **Storage Credit System**: Pre-purchase storage credits with a 10% revenue margin
- **DAO Integration**: Designed for use with Sputnik DAOs
- **Content-Addressed Lists**: Payment lists are identified by their SHA-256 hash

## Token Support

| Token Type | Token ID Format | Payment Method |
|------------|-----------------|----------------|
| Native NEAR | `native`, `near`, `NEAR` | Direct transfer |
| NEP-141 FT | `<contract_id>` | `ft_transfer` |
| NEAR Intents | `nep141:<token_contract>` | `ft_withdraw` via intents.near |

## API Reference

### Storage Management

#### `calculate_storage_cost(num_records: u64) -> NearToken`
Calculate the required deposit for a given number of payment records.

#### `buy_storage(num_records: u64, beneficiary_account_id: Option<AccountId>) -> NearToken`
Purchase storage credits. Requires exact deposit.

#### `view_storage_credits(account_id: AccountId) -> NearToken`
View current storage credits for an account.

### Payment List Operations

#### `submit_list(list_id: ListId, token_id: String, payments: Vec<PaymentInput>, submitter_id: Option<AccountId>) -> ListId`
Submit a new payment list. Requires storage credits.

#### `approve_list(list_id: ListId)`
Approve a payment list. Requires exact payment deposit.

#### `reject_list(list_id: ListId)`
Reject a pending payment list.

#### `view_list(list_id: ListId) -> PaymentList`
View payment list details.

### Payment Processing

#### `payout_batch(list_id: ListId) -> u64`
Process approved payments in batches. Returns remaining pending count.

#### `get_payment_transactions(list_id: ListId) -> Vec<PaymentTransaction>`
Get completed payment transactions with block heights.

### Token Callbacks

#### `ft_on_transfer(sender_id: AccountId, amount: U128, msg: String) -> U128`
NEP-141 callback for fungible token approval.

#### `mt_on_transfer(sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> Vec<U128>`
NEP-245 callback for multi-token approval.

## List ID Calculation

List IDs are SHA-256 hashes of the canonical payment list:

```javascript
function generateListId(submitterId, tokenId, payments) {
  const sortedPayments = [...payments].sort((a, b) =>
    a.recipient.localeCompare(b.recipient)
  );
  const canonical = JSON.stringify({
    payments: sortedPayments.map((p) => ({
      amount: p.amount,
      recipient: p.recipient,
    })),
    submitter: submitterId,
    token_id: tokenId,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
```

## Storage Costs

Each payment record requires 216 bytes of storage:
- AccountId: 100 bytes max
- amount: 16 bytes (u128)
- status: ~50 bytes
- overhead: ~50 bytes

Storage cost = `216 * num_records * 10^19 yoctoNEAR * 1.1`

## Usage Example

### 1. Purchase Storage

```bash
near call bulk-payment.near buy_storage \
  '{"num_records": 100}' \
  --accountId dao.near \
  --deposit 2.3760 \
  --gas 30000000000000
```

### 2. Submit Payment List

The API service verifies the list_id and DAO proposal before submission.

### 3. Create DAO Proposal

```bash
near call dao.sputnik-dao.near add_proposal \
  '{"proposal": {"description": "Bulk payment: <list_id>", "kind": {"FunctionCall": {"receiver_id": "bulk-payment.near", "actions": [{"method_name": "approve_list", "args": "<base64>", "deposit": "<total_amount>", "gas": "150000000000000"}]}}}}' \
  --accountId member.near \
  --deposit 0.1
```

### 4. Approve Proposal

```bash
near call dao.sputnik-dao.near act_proposal \
  '{"id": <proposal_id>, "action": "VoteApprove"}' \
  --accountId member.near \
  --gas 300000000000000
```

### 5. Process Payments

Payments are processed automatically by the API worker, or manually:

```bash
near call bulk-payment.near payout_batch \
  '{"list_id": "<list_id>"}' \
  --accountId any.near \
  --gas 300000000000000
```

## Building

```bash
# Build WASM
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test
```

## Testing

```bash
# Unit tests
cargo test --lib

# Integration tests (requires near-sandbox)
cargo test --tests
```

## License

MIT
