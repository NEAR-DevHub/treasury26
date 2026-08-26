
# Confidential Treasury

## Concept

A confidential treasury allows a sputnik-dao.near DAO to shield tokens into the **private intents** system — a NEAR-based confidential ledger running inside a TEE (Trusted Execution Environment) network. Shielded tokens are invisible on-chain; only the DAO can see its confidential balances via authenticated API calls.

Since DAOs have no access keys, all signing is done via **MPC (multi-party computation)** using the `v1.signer` contract (chain-signatures). The backend automatically extracts MPC signatures from approved proposals and submits signed intents to the 1Click API.

## Architecture: near.com vs DAO

| Aspect | near.com (individual) | Treasury26 (DAO) |
|--------|----------------------|-------------------|
| Account | `alice.near` | `mydao.sputnik-dao.near` |
| Signer ID | `near:alice.near` | `near:mydao.sputnik-dao.near` |
| Signing | Wallet signs off-chain (NEP-413) | DAO proposal → `v1.signer` contract (MPC chain-signatures) |
| Auth flow | Synchronous (sign → submit in one step) | Asynchronous (proposal → approval → backend auto-submits) |
| Access keys | User's wallet key | None — must use MPC |

### Key Challenge: DAO Signing

The near.com flow assumes synchronous wallet signing via NEP-413. DAOs don't have wallet keys. Two types of signing proposals are needed:

#### 1. JWT Authentication (infrequent)

Before the DAO can get quotes or view confidential balances, the backend needs a JWT token from the 1Click API. This requires an MPC-signed auth payload.

1. Frontend calls `POST /api/confidential-intents/prepare-auth` → backend builds NEP-413 auth message, computes hash, returns v1.signer proposal args
2. Frontend creates DAO proposal calling `v1.signer.sign()` with the auth hash
3. DAO council approves the proposal
4. Backend relay detects MPC signature in execution result → auto-calls 1Click `/v0/auth/authenticate`
5. Backend stores JWT (access + refresh tokens) per-DAO in `monitored_accounts`

The access token lasts ~15 minutes (auto-refreshed). The refresh token lasts ~7 days.

#### 2. Shield Intent Signing (per operation)

Each shield operation needs a signed intent:

1. Frontend gets quote from `POST /api/confidential-intents/quote` (requires JWT)
2. Frontend calls `POST /api/confidential-intents/generate-intent` → backend stores the intent payload and returns the NEP-413 payload
3. Frontend creates DAO proposal calling `v1.signer.sign()` with the intent hash
4. DAO council approves the proposal
5. Backend relay detects MPC signature → auto-calls 1Click `/v0/submit-intent` with the stored intent payload + signature

**Prerequisite:** The DAO must already have tokens deposited to `intents.near` (via `ft_transfer_call` on `wrap.near`). The shield operation moves tokens from the DAO's public intents balance to its confidential balance.

## 1Click Confidential API

### Base URL & Auth

- **API Base URL:** `https://1click-test.chaindefuser.com` (env var `CONFIDENTIAL_API_URL`, configurable for sandbox mock)
- **API Key:** `x-api-key` header (env var `ONECLICK_API_KEY`)
- **JWT Auth:** `Authorization: Bearer <jwt>` header for authenticated operations (quotes, generate-intent, balances)

### Endpoints Used

| Endpoint | Method | JWT Required | Description |
|----------|--------|-------------|-------------|
| `/v0/auth/authenticate` | POST | No (produces JWT) | Exchange signed NEP-413 payload for JWT tokens |
| `/v0/auth/refresh` | POST | No | Refresh an expired access token |
| `/v0/quote` | POST | Yes | Get a shield quote |
| `/v0/generate-intent` | POST | Yes | Generate the NEP-413 intent payload to sign |
| `/v0/submit-intent` | POST | No | Submit the MPC-signed intent |
| `/v0/account/balances` | GET | Yes | View confidential token balances |

### Quote Request (Shield)

```json
{
  "dry": false,
  "swapType": "EXACT_INPUT",
  "slippageTolerance": 100,
  "originAsset": "nep141:wrap.near",
  "depositType": "INTENTS",
  "destinationAsset": "nep141:wrap.near",
  "amount": "10000000000000000000000",
  "refundTo": "mydao.sputnik-dao.near",
  "refundType": "CONFIDENTIAL_INTENTS",
  "recipient": "mydao.sputnik-dao.near",
  "recipientType": "CONFIDENTIAL_INTENTS",
  "deadline": "<ISO timestamp, 24h from now>",
  "quoteWaitingTimeMs": 5000
}
```

Note: `recipientType` and `refundType` use `CONFIDENTIAL_INTENTS`. The `depositType` uses `INTENTS`.

### Generate Intent Request

```json
{
  "type": "swap_transfer",
  "standard": "nep413",
  "depositAddress": "<from quote response>",
  "signerId": "mydao.sputnik-dao.near"
}
```

### Submit Intent Request

```json
{
  "type": "swap_transfer",
  "signedData": {
    "standard": "nep413",
    "payload": {
      "message": "<intent JSON from generate-intent>",
      "nonce": "<base64 nonce from generate-intent>",
      "recipient": "intents.near"
    },
    "public_key": "ed25519:<MPC derived public key>",
    "signature": "ed25519:<MPC signature>"
  }
}
```

### MPC Public Key

The MPC public key is derived per-DAO from `v1.signer` using:
```
v1.signer.derived_public_key({ path: "mydao.sputnik-dao.near", predecessor: "mydao.sputnik-dao.near", domain_id: 1 })
```

This returns the Ed25519 key that the 1Click API uses to verify the signature. The backend fetches this dynamically for each DAO.

### Auth Nonce Format

The 1Click API validates a specific nonce format (32 bytes):
- Bytes 0-3: Magic prefix `[0x56, 0x28, 0xF6, 0xC6]`
- Byte 4: Version `0`
- Bytes 5-8: Salt from `intents.near::current_salt()`
- Bytes 9-16: Deadline in nanoseconds (LE)
- Bytes 17-24: Current time in nanoseconds (LE)
- Bytes 25-31: Random bytes

## Backend Architecture

### API Endpoints

All confidential endpoints are under `/api/confidential-intents/` and require authenticated user + DAO membership:

| Endpoint | Handler | Description |
|----------|---------|-------------|
| `POST /api/confidential-intents/prepare-auth` | `prepare_auth.rs` | Build auth proposal args |
| `POST /api/intents/deposit-address` | `deposit_address.rs` | Get deposit quote + deposit address allowing anybody to submit |
| `POST /api/confidential-intents/generate-intent` | `generate_intent.rs` | Generate intent + store for auto-submit |
| `GET /api/user/assets` | `assets.rs` | View balance depending on whether the user is a confidential treasury member |

Note: `authenticate` and `submit-intent` are not exposed as frontend-facing endpoints. The backend handles both automatically via the relay's auto-submit flow after proposal approval.

### Auto-Submit Flow (relay integration)

The relay handler (`handlers/relay/confidential.rs`) automatically handles post-approval:

1. After any vote relay succeeds, checks for MPC signature marker (`eyJzY2hlbWUi`) in execution result
2. If found, looks up pending intent/auth in `confidential_intents` table
3. For **auth**: calls 1Click `/v0/auth/authenticate`, stores JWT in `monitored_accounts`
4. For **shield**: calls 1Click `/v0/submit-intent` with the stored intent payload + signature

### Database Tables

- `monitored_accounts` — stores the 1Click JWTs per DAO as AES-256-GCM envelopes (`confidential_credentials_enc` for the DAO scope, `bulk_payment_credentials_enc` for the bulk-payment subaccount) plus plaintext expiry metadata (`confidential_token_expires_at`, `bulk_payment_token_expires_at`). The encryption key lives only in the `CONFIDENTIAL_TOKEN_KEYRING_JSON` env secret; all reads/writes go through `ConfidentialCredentialStore` (`services/confidential_credentials.rs`). The legacy plaintext token columns remain only until the encrypted rollout completes.
- `confidential_intents` — stores intent payloads (or auth payloads) awaiting MPC signature, with `intent_type` ('shield' or 'auth') and `status` ('pending', 'submitted', 'failed')

## Sandbox Testing

The sandbox includes:
- **Mock v1.signer** (`sandbox/contracts/mock_signer.wat`) — returns hardcoded Ed25519 signature + `derived_public_key`
- **Mock v2.ref-finance.near** (`sandbox/contracts/mock_ref_finance.wat`) — returns token whitelist
- **Mock 1Click API** (in `sandbox-init/src/mock_server.rs`) — serves quote, generate-intent, submit-intent, authenticate, balances on port 4000
- **Delegate action signing** (`/_test/sign-delegate-action`) — signs with sandbox genesis key for the mock wallet

The Playwright E2E test runs the full flow: authenticate → get quote → sign intent → auto-submit — using real relay transactions through the sandbox blockchain.

## References

- Defuse frontend (individual account implementation): https://github.com/defuse-protocol/defuse-frontend/pull/962
- Chain Signatures (MPC signer): https://docs.near.org/chain-abstraction/chain-signatures
- 1Click API (test): https://1click-test.chaindefuser.com
