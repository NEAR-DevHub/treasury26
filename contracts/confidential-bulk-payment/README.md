# Confidential Bulk Payment

Per-DAO subaccount that signs N opaque payload hashes via `v1.signer` MPC for one approved sputnik-dao bulk-payment proposal. Lives at `<dao_prefix>.bulk-payment.near`, deployed by the `bulk-payment.near` factory using a NEAR global contract.

Companion to [`bulk-payment`](../bulk-payment) (public bulk payments). This contract handles the **confidential** path where recipients/amounts must stay opaque on-chain.

---

## Why

Confidential treasuries route transfers through `v1.signer` MPC. Each recipient transfer becomes an opaque payload hash; only the DAO and 1Click see plaintext. A bulk payment is one DAO proposal that:

1. Signs **one** quote `treasury → <dao>.bulk-payment.near` (regular single-confidential flow).
2. Lists **N** additional payload hashes in its description: `<dao>.bulk-payment.near → recipient_i`. These need a different signer (the subaccount, not the DAO), so the regular flow can't handle them.

This contract is the second-step signer. It reads the approved proposal on-chain (no off-chain trust), then signs each hash through `v1.signer` on demand.

---

## Architecture

```
bulk-payment.near                  (factory)
└── <dao>.bulk-payment.near        (this contract — one per DAO)
        owner_dao  = <dao>.sputnik-dao.near
        bootstrap  = Pending → InProgress → Ready { mpc_public_key }
        activations: proposal_id → Activation
                       ├── status: Loading | Ready { cursor } | Done
                       ├── hashes: [HashEntry { payload_hash, status }]
                       │     status: Pending | Signing | Signed { sig } | SignFailed | Invalid
                       ├── payer
                       └── deposit
```

Naming binding: the subaccount's `init` requires `current_account_id` and `owner_dao` to share a prefix (`<dao>.bulk-payment.near` ↔ `<dao>.sputnik-dao.near`). Signatures issued by this account can therefore only ever be requested by the matching DAO.

External calls (typed proxies in [`mpc.rs`](src/mpc.rs), [`intents.rs`](src/intents.rs), [`sputnik.rs`](src/sputnik.rs)):
- `v1.signer.derived_public_key` / `sign`
- `intents.near.add_public_key`
- `<dao>.sputnik-dao.near.get_proposal`

---

## Lifecycle

### 1. Deploy (factory call, anyone)
`bulk-payment.near::create_confidential_subaccount(dao_id)` — permissionless, caller-funded. Creates `<prefix>.bulk-payment.near`, `use_global_contract`s the code, calls `init(owner_dao)` then `bootstrap()`.

### 2. Bootstrap (auto from factory)
- Fetch MPC pubkey: `v1.signer.derived_public_key(path="", predecessor=self, domain_id=1)`.
- Register: `intents.near.add_public_key(pk)` (1 yocto deposit).
- State → `Ready { mpc_public_key }`. Failure → `Failed { reason }`; anyone can call `retry_bootstrap`.

### 3. Activate (anyone, payable)
`activate(proposal_id)` — caller attaches `activate_required_deposit()` worth of NEAR (worst-case storage for `MAX_HASHES_PER_ACTIVATION`=200 entries + 1 yocto per sign). Contract:
- Calls `owner_dao.get_proposal(id)`.
- Validates: `status == Approved`, `kind.FunctionCall.receiver == v1.signer`, header action = `sign`.
- Parses `payload_hashes` from description (CSV or JSON; mirrors `extract_from_description` in `nt-be`).
- Each hash → `HashEntry { status: Pending | Invalid }`. Bad hex marked Invalid, not aborted.
- Refunds excess deposit to caller (actual storage cost based on real `hashes.len()`).

### 4. Ping (anyone)
`ping(proposal_id)` — iterates `Pending` entries while gas budget allows (8 TGas attached + 5 TGas callback + 15 TGas reserve per iter ⇒ ~22 signs per 300 TGas ping):
- Dispatches `v1.signer.sign(request)` with 1-yocto deposit.
- Marks entry `Signing`.
- Callback `on_sign` parses `MpcSignResponse::Ed25519 { signature }` → `Signed { signature: [u8; 64] }`. Failure → `SignFailed { reason }`.
- Cursor advances; activation state moves `Ready { cursor }` → `Done` when all entries non-`Pending`.

### 5. Retry failed (anyone)
`retry_failed(proposal_id)` resets `SignFailed` entries to `Pending`, rewinds cursor, state back to `Ready`. Next `ping` will retry them.

---

## Trust model

- **Activation source-of-truth = on-chain proposal.** Caller can't inject hashes; they come from `get_proposal`.
- **All entry points permissionless.** Replays are no-ops (`activate` already-loaded → log + return; `ping` skips non-Pending; `bootstrap` rejects in-flight/Ready).
- **Per-DAO isolation.** Naming binding enforced at `init`; `path=""` for both pubkey derivation and signing means only this subaccount's calls produce signatures under its registered key.

---

## Storage cost

Computed dynamically via `env::storage_byte_cost()`:
- `BYTES_PER_HASH = 200` (conservative borsh size: hash + status enum + map overhead)
- `BYTES_PER_ACTIVATION = 130` (status + payer + Vec hdr + map entry)
- Plus 1 yocto per hash for `sign` deposits.

Worst-case at 200 hashes, current mainnet rate (1e19 yocto/byte): ~0.4 NEAR. View `activate_required_deposit()` returns this; backend reads it before submitting.

---

## Build

```bash
cargo near build non-reproducible-wasm --locked
```

Reproducible build (for global-contract deploy):

```bash
cargo near build
```

## Test

```bash
cargo test
```

Integration tests in [`tests/test_basics.rs`](tests/test_basics.rs).

---

## Deploy as global contract

```bash
# Deploy code globally (one-time, hash-keyed)
near contract deploy <code-account> use-file <wasm> as-global-hash

# Register the hash with the factory (DAO/upgrade flow only)
near contract call-function as-transaction bulk-payment.near \
  set_confidential_code_hash json-args '{"code_hash": "<base58-hash>"}'
```

After that, any user can call `bulk-payment.near::create_confidential_subaccount({dao_id})` to bootstrap a per-DAO instance.
