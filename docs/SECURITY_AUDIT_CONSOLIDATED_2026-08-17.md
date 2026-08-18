# Trezu Security Audit — Consolidated & Verified

**Classification:** Confidential — Security Sensitive
**Date:** 17 August 2026
**Snapshot:** `20a6077a` on branch `chore/security_fixes`
**Basis:** Codex repository scan (`SECURITY_AUDIT_REPORT_2026-08-17.md`) + independent line-by-line verification of every finding against source, plus new issues found during verification.

> This is the working tracker. Every finding below was re-confirmed against the actual code with file:line evidence. We fix them one by one and check them off in the **Status** column.

## How to read this

- **Status** — `VERIFIED` (confirmed in source), `NEW` (found during our verification, not in the Codex scan), `REFUTED` (claimed but not a real issue). Update to `FIXED` (+ PR/commit) as we go.
- Every finding has concrete **file:line** anchors so the fix is unambiguous.
- Severities reflect impact in Trezu's architecture, not raw scanner labels.

## Finding tracker

| ID | Sev | Status | Finding | Primary files |
|---|---|---|---|---|
| N-01 | High | **FIXED** | Unauthenticated treasury creation spends backend-signer funds | `nt-be/src/handlers/treasury/create.rs`, `nt-fe/lib/api.ts` |
| N-02 | High | **FIXED** | Unauthenticated confidential setup drives signer-approved DAO actions | `nt-be/src/handlers/treasury/create.rs` (same endpoint) |
| C-01 | Critical | **FIXED** | Token-receiver callbacks don't authenticate the calling token contract | `contracts/bulk-payment/src/lib.rs` |
| C-02 | Critical | **FIXED** | `approve_list` lets a NEAR deposit approve an FT/MT list → cross-token drain | `contracts/bulk-payment/src/lib.rs` |
| H-01 | High | **FIXED** | Payouts marked `Paid` before async transfer resolves (no settlement callback) | `contracts/bulk-payment/src/lib.rs` |
| H-02 | High | VERIFIED | Fixed-price storage credits accept unbounded strings; no cleanup/refund | `contracts/bulk-payment/src/lib.rs` |
| H-03 | High | **FIXED** | Relayer top-up before submission; credits not atomically reserved | `nt-be/src/handlers/relay/*` |
| H-04 | High | VERIFIED | Wallet `postMessage` lacks origin/source/nonce validation; opener uses `"*"` | `nt-fe/near-connect/src/trezu-wallet.ts`, `nt-fe/app/wallet/utils/opener.ts` |
| H-05 | High | **FIXED** | JSON injection: payout args built with `format!` on attacker strings | `contracts/bulk-payment/src/lib.rs` |
| H-06 | High | VERIFIED | Known-vulnerable dependencies across JS + Rust graphs | lockfiles |
| M-01 | Medium | VERIFIED | No global admission control; shared `reqwest::Client` has no timeout | `nt-be/src/main.rs`, `app_state.rs` |
| M-02 | Medium | VERIFIED | Privileged `workflow_run` publishes PR-controlled HTML to Pages | `.github/workflows/e2e-report.yml`, `frontend-e2e.yml` |
| M-03 | Medium | VERIFIED | Confidential bearer tokens & intent metadata stored plaintext | confidential migrations |
| M-04 | Medium | NEW | `payout_batch` panics on one malformed recipient/token → list bricked (DoS) | `contracts/bulk-payment/src/lib.rs` |
| M-05 | Medium | NEW | `verify_member_if_confidential` fails open for non-monitored accounts | `nt-be/src/auth/middleware.rs` |
| L-01 | Low | VERIFIED | No browser security headers; `x-powered-by` exposed | `nt-fe/next.config.ts` |
| L-02 | Low | VERIFIED | CI actions/toolchains not SHA-pinned; unfrozen installs | `.github/workflows/*`, `render.yaml` |
| L-03 | Low | VERIFIED | Public `/api/health` leaks instance UUID, leadership state, last errors | `nt-be/src/routes/mod.rs`, `jobs/leadership.rs` |

---

## Detailed findings

### N-01 / N-02 — Unauthenticated treasury creation & confidential setup spend backend-signer funds (High) — FIXED

**Files:** `nt-be/src/handlers/treasury/create.rs`, `nt-fe/lib/api.ts`

**Evidence.** `POST /api/treasury/create-stream` → `create_treasury_stream` had **no auth extractor** (only `State` + `Json`). It runs `run_creation` → `run_creation_inner`, which makes the backend signer pay `TREASURY_CREATE_DEPOSIT` (0.09 NEAR) to the factory `create` call (create.rs ~618–634) with `.with_signer(state.signer_id, state.signer)`. When `is_confidential = true`, the same path runs `setup_confidential_treasury`, which has the signer **submit and self-approve** multiple on-chain proposals (`add_public_key` with an attached deposit, the `create_confidential_subaccount` factory call funded with 0.15 NEAR, an auth proposal, and `ChangePolicy`) — all signer-funded. Anyone could POST arbitrary member lists and drain the sponsor wallet per request, bounded only by the env kill-switch and a per-account advisory lock.

The related `bulk_activation` handlers were already correctly gated (`AuthUser` + `verify_can_add_proposal`), and the background `creation_sweeper` only resumes creation requests that were authorized when first submitted — so `create_treasury_stream` was the single unauthenticated entry into the signer-driven flow. Fixing it closes both findings.

**Fix (applied).**
- `create_treasury_stream` now requires the `AuthUser` (session cookie) extractor, and rejects with `403` unless the authenticated account is one of the new DAO's members (`caller_is_member` over requestors ∪ governors ∪ financiers). This ties every signer-funded creation to a NEP-413-proven account, making anonymous drain impossible and each request attributable/rate-limitable.
- Frontend `createTreasuryStream` now sends `credentials: "include"` so the auth cookie accompanies the request. The onboarding UI already includes the connected account in all three role lists, so legitimate creation is unaffected.
- Regression test `caller_is_member_gates_signer_spend` asserts members pass and a non-member/the DAO account itself are rejected.

**Residual / follow-ups (not blocking closure):** add per-account/IP rate limiting on this route (ties into M-01), and consider a small refundable deposit or credit gate to bound spend from a compromised but valid session.

### C-01 — Token-receiver callbacks don't authenticate the calling token contract (Critical) — FIXED

**Status: FIXED.** Already handled by the CTO in the production contract deployment.

**Files:** `contracts/bulk-payment/src/lib.rs`
**CWE:** 345 (Insufficient Verification of Data Authenticity), 284 (Improper Access Control)

**Verified evidence.** Both receiver callbacks are `pub` and validate only caller-supplied arguments — neither checks `env::predecessor_account_id()`:

- `ft_on_transfer` (lines 608–665): checks `validate_list_id` (612), `list.submitter == sender_id` (625–628), `Pending` (631–634), `amount.0 == total_amount` (645–651). **No predecessor check, and it never compares `list.token_id` to any caller.**
- `mt_on_transfer` (lines 806–891): checks list id/status/amount and `list.token_id == token_ids[0]` (853–859) — but `token_ids` is the caller's argument, and line 815 explicitly discards identity: `let _ = (previous_owner_ids, sender_id);`. **No predecessor check.**

**Impact.** An attacker submits a list (only needs cheap storage credits), then calls `ft_on_transfer`/`mt_on_transfer` directly with `sender_id` = their own submitter id and `amount` = the list total. No tokens move; line 654 flips the list to `Approved`. The permissionless `payout_batch` (394–533) then transfers the contract's *pooled* balances to attacker-chosen recipients. Max loss = the contract's accessible balance of each token.

**Fix.**
1. In both callbacks, require `env::predecessor_account_id()` == the exact token contract recorded for the list (derive the expected contract from `list.token_id`, e.g. `nep141:` → the FT account; MT → `intents.near`).
2. Reject every mismatch before any state mutation.
3. Treat serialized args as untrusted; the predecessor is the only proof a transfer occurred.
4. Add invariant tests calling both callbacks from an arbitrary predecessor and asserting rejection with no state change.

**Retest.** Direct calls from an arbitrary account fail for FT and MT; a transfer from the wrong token contract fails even with valid symbol/amount/sender/msg; legitimate transfer approves only the matching list.

### C-02 — `approve_list` lets a NEAR deposit approve an FT/MT list (Critical, NEW) — FIXED

**Status: FIXED.** Already handled by the CTO in the production contract deployment.

**Files:** `contracts/bulk-payment/src/lib.rs` (lines 316–364)

**Verified evidence.** `approve_list` requires `attached_deposit == total_amount` in yoctoNEAR (344–353) but never checks that `list.token_id` is native NEAR. An attacker submits an FT list, then calls `approve_list` attaching NEAR numerically equal to the token amount (cheap for small amounts / low-decimal tokens). `payout_batch` then issues `ft_transfer` (497–504) drawing from the contract's FT balance held for other lists. This is a second, independent approval bypass distinct from C-01 (it doesn't even require forging a callback).

**Fix.** Gate `approve_list` to native lists only (`require!` `token_id` is `native`/`near`/`NEAR`), or make the deposit-vs-token accounting token-aware and per-list escrowed. Add a test: FT list + NEAR `approve_list` must reject.

### H-01 — Payouts marked `Paid` before async transfer resolves (High) — FIXED

**Status: FIXED.** Already handled by the CTO in the production contract deployment.

**Files:** `contracts/bulk-payment/src/lib.rs` (`payout_batch`, 394–533)

**Verified evidence.** All three transfer paths are fire-and-forget `.detach()`: intents `ft_withdraw` (466–473), native `transfer` (482–484), NEP-141 `ft_transfer` (497–504). Immediately after, unconditionally, `payment.status = Paid { block_height }` (507–510), and the list is persisted (516). There is **no** `#[private]` callback inspecting `PromiseResult` anywhere in the file.

**Impact.** Any downstream failure (unregistered recipient, insufficient balance, paused token, bad gas) leaves a permanent false `Paid` record; retry logic can never re-select it; funds may be stranded and audit history is wrong.

**Fix.** Introduce `InFlight` + unique attempt id before dispatch; chain each transfer to a `#[private]` callback that inspects the result; mark `Paid` only on success, else back to `Pending`/retryable `Failed`; make callbacks idempotent; block concurrent dispatch of an in-flight payment. (The confidential contract already does this — mirror it.)

### H-02 — Fixed-price storage credits accept unbounded data; no cleanup (High)

**Files:** `contracts/bulk-payment/src/lib.rs`

**Verified evidence.** `calculate_storage_cost` uses `const BYTES_PER_RECORD: u64 = 216;` (line 134) + 10% margin (146–149). Credits are a pure count decoupled from bytes: `buy_storage` adds `num_records` (196), `submit_list` deducts `payments.len()` (264/281). `PaymentInput.recipient` (37/44) and list `token_id` (63) are unbounded `String`s never length-validated in `submit_list` (232–313); `token_id` isn't counted in the 216-byte figure at all. `reject_list` (536–560) only flips status and re-inserts (556–557) — no `payment_lists.remove` exists anywhere, and credits are never refunded.

**Impact.** Buy 1 credit (~216 bytes priced), store multi-KB strings → underpayment; repeat to lock the contract's NEAR against state storage and block legitimate writes. Backend validation is not a boundary since methods are public.

**Fix.** Charge the exact `env::storage_usage()` before/after delta per write (incl. collection overhead); enforce strict byte limits on `token_id`/`recipient` and a contract-level max payments/list; fail atomically on insufficient credit; add a reviewed cleanup/reclamation lifecycle with ownership + list-state checks; correct any docs implying cleanup exists.

### H-03 — Relayer top-up before submission; credits not atomically reserved (High) — FIXED

**Status: FIXED (for now).**

**Files:** `nt-be/src/handlers/relay/submit.rs`, `sponsor/policy.rs`, `sponsor/mod.rs`, `effects/accounting.rs`, `access.rs`, `parse/mod.rs`
**CWE:** 362 (Race Condition), 770 (Allocation Without Limits)

**Verified evidence.** Order of operations in `relay_delegate_action` (`submit.rs:50`):
1. Parse borsh action (67–78).
2. `authorize` **reads** credits via plain `SELECT` and gates on `has_gas_covered_credits` (`access.rs:45–53,139–156`).
3. `enforce_deposit_limit` (101).
4. **`top_up_proposal_storage` → `transfer_once` fires NEAR to the DAO** (109–117, `policy.rs:134–159`, `sponsor/mod.rs:142–157`) — *before* submission.
5. `submit_relay` on-chain (141).
6. Only on success: `spawn_charge` decrements credit in a **detached background task** (155, `accounting.rs:19–88`).

No DB transaction, no `FOR UPDATE`, no reservation, no idempotency key (grep-confirmed).

- **(a)** `storage_bytes` is a client field (`parse/mod.rs:48`, `submit.rs:59`), cost = `STORAGE_COST_PER_BYTE (1e19) * bytes` capped at `MAX_PROPOSAL_STORAGE_BYTES = 4000` → **0.04 NEAR max/request**, sent to the attacker's own DAO, never validated against real proposal size, over-claim not refunded.
- **(b)** On `submit_relay` error, `spawn_record_spend(... consume_credit=false)` records `paid_near` but leaves `gas_covered_transactions` untouched (`accounting.rs:26–74`) — the NEAR is already gone. Attacker loops a deliberately-failing action to drain the sponsor without ever spending a credit.
- **(c)** N concurrent requests all read the same credit in step 2 and all proceed; `GREATEST(x-1,0)` only floors the counter, doesn't prevent over-spend. TOCTOU double-spend confirmed. No rate limit on the route (`routes/mod.rs:297`).

**Fix.** Derive required storage from the decoded/validated action server-side (never trust `storage_bytes`); fully parse+preflight before any spend; reserve/decrement a credit in the **same DB transaction** that creates a unique relay attempt (row lock or conditional atomic update); charge any attempt that caused an on-chain sponsor transfer even if relay later fails; idempotency keyed by signed-action hash; per-user/per-DAO/sponsor-wallet value & rate limits + spend alarms; durable reconciliation of `paid_near` vs credits vs final tx state.

**Interim containment:** disable automatic storage top-ups until reservation + server-derived storage are in place.

**Progress — steps 1–3 applied (2026-08-18):**
- **Step 1 (bug a):** `storage_bytes` is now derived server-side from the actual parsed `add_proposal` args (`ParsedRelay::proposal_storage_bytes`, `parse/mod.rs`) and clamped to the 4000-byte cap in `proposal_storage_cost` (`policy.rs`). The client's `storageBytes` is still accepted on the wire but ignored — it can no longer inflate the top-up.
- **Step 2:** the request is fully parsed, authorized, and deposit-checked, and the credit is reserved **before** any sponsor NEAR moves (`submit.rs` reordered).
- **Step 3 (bug c):** credits are reserved atomically via `UPDATE … WHERE gas_covered_transactions > 0 RETURNING` (`accounting::reserve_gas_credit`), replacing the read-then-background-decrement. Concurrent relays for a one-credit treasury now resolve to exactly one reservation (regression test `concurrent_reservations_cannot_double_spend_one_credit`). Enterprise stays unlimited; every failure path refunds the reservation.

**Still open — deferred steps 4–6:** bug (b)'s fail-path drain is *reduced* (top-up is now proportional to the real proposal and attributable) but not closed — a failed relay still refunds the credit (step 4 will keep it charged when NEAR already moved). No idempotency on the signed-action hash yet (step 5). No per-account/per-DAO/sponsor-wallet value caps or spend alarms yet (step 6).

### H-04 — Wallet `postMessage` lacks origin/source/nonce validation (High)

**Files:** `nt-fe/near-connect/src/trezu-wallet.ts`, `nt-fe/app/wallet/utils/opener.ts`
**CWE:** 346 (Origin Validation Error)

**Verified evidence.**
- **(a)** Handler (`trezu-wallet.ts:296–352`) filters only on `message.type.startsWith("trezu:")`; registered globally at 354. It never checks `event.origin` or `event.source`, though it holds `childWindow` from `window.selector.open` (258) and never compares it.
- **(b)** Sign-in callback (108–125) persists `accountId` to `localStorage` on mere truthiness; no nonce/state is generated in `requestSignIn` (111–114) or checked in the response.
- **(c)** `opener.ts:5–9` sends results with `window.opener.postMessage(data, "*")` for sign-in/transaction payloads (`use-wallet-flow.ts:209,273,342,392`) — the `callbackUrl` origin is on hand (59,152) but discarded.

**Impact.** A malicious page with a window reference can forge sign-in/pending/completion messages, spoofing the connected account and transaction outcome in an integrating dApp; the popup also leaks result payloads to any opener origin.

**Fix.** Pin the exact expected wallet origin; require `event.origin === expectedOrigin && event.source === childWindow`; generate a cryptographically-random single-use nonce/state per request and require it in every response; validate a strict discriminated schema; use the validated callback origin as `targetOrigin` — never `"*"` for credential/tx messages.

**Note (low, related):** `nt-fe/components/ui/chart.tsx:83` uses `dangerouslySetInnerHTML` for a `<style>` block from chart config; only exploitable if untrusted data reaches `config[].color`/`theme`. Keep config trusted.

### H-05 — JSON injection in payout args via `format!` on attacker strings (High, NEW) — FIXED

**Status: FIXED.** All three payout-arg builders (`ft_withdraw` PoA + non-PoA, and NEP-141 `ft_transfer`) now serialize with `serde_json::json!` via two pure helpers (`build_intents_withdraw_args`, `build_ft_transfer_args`); the untrusted `recipient` is escaped, including inside the PoA `WITHDRAW_TO:` memo. Five unit tests assert malicious recipients (embedded `"`/`,`/`}` and brace-injection) round-trip as a single escaped `receiver_id`/memo value with no injected or overridden keys, plus a benign-input regression guard. `cargo test --lib` → 21 passed.

**Files:** `contracts/bulk-payment/src/lib.rs` (`build_intents_withdraw_args`, `build_ft_transfer_args`, `payout_batch`)

**Verified evidence.** Cross-contract call args are built by string interpolation of attacker-controlled `recipient`/`token_contract`:
```rust
format!(r#"{{"receiver_id":"{}","amount":"{}"}}"#, payment.recipient, payment.amount.0)
```
Because `recipient` is an unbounded string (arbitrary external-chain address on the intents path), a value containing `"`/`,`/`}` can inject or override JSON fields (alter `amount`, add a `memo`, redirect `receiver_id`).

**Fix.** Build all call args with `serde_json`/`json!`, never `format!`. Add tests with recipients containing quotes/braces asserting the serialized args are escaped.

### H-06 — Known-vulnerable dependencies across JS + Rust (High)

**Files:** JS and Rust lockfiles.

**Evidence (scanner-based; needs reachability triage).** `nt-fe` 80 advisories / 22 packages (1 crit, 40 high); `e2e-tests/bulk-payment` prod graph 13; `nt-be` 7 RustSec; `nt-cli` 3; contracts 2 each (mostly test/build deps); `sandbox` 9. Notable: critical/high `tar` via the NEAR Intents/Omni Bridge chain, `@solana/web3.js`/`bigint-buffer`, `fast-uri`, transitive `axios`, `serialize-javascript`, `ws`; Rust `quinn-proto` memory exhaustion, `rustls-webpki`, `rkyv` OOB read (CLI), `rsa` Marvin timing (no upstream fix).

**Fix.** Produce a per-advisory reachability matrix (runtime/build/test, feature, attacker input, target, fixed version, owner); upgrade/override the Intents/Omni chain; update backend TLS/QUIC deps and confirm whether the QUIC path is enabled; isolate/replace unfixed `rsa` where secrets + attacker-observable timing coexist; upgrade CLI `rkyv`; add blocking `cargo audit` + JS audit to CI with expiring exceptions.

### M-01 — No global admission control; untimed HTTP client (Medium)

**Files:** `nt-be/src/main.rs:92–132`, `app_state.rs:546`

**Verified evidence.** Top-level router layers only CORS, `TraceLayer`, and two Sentry layers — no rate/concurrency/timeout layer (grep for `TimeoutLayer`/`ConcurrencyLimit`/`tower_governor` = 0; `tower-http` features = `cors,trace` only). Shared client is `reqwest::Client::new()` (no total timeout); also in `bin/rpc_cache_proxy.rs:95`, `handlers/balance_changes/goldsky_enrichment.rs:653`. Only outbound third-party rate limiting exists (`utils/rate_limiter.rs`), which doesn't gate inbound.

**Fix.** Token buckets by IP/account/DAO/endpoint cost; global + endpoint concurrency limits and deadlines; build the HTTP client with connect/request/idle/response-size limits; queue+dedupe expensive repair/refresh work; move challenge-expiry cleanup to a scheduled job; metrics for rejected/queued/timed-out/saturated.

### M-02 — Privileged workflow publishes PR-controlled HTML to Pages (Medium)

**Files:** `.github/workflows/e2e-report.yml`, `frontend-e2e.yml`, `e2e-report-cleanup.yml`
**CWE:** 829

**Verified evidence.** Producer `frontend-e2e.yml` runs PR code on `pull_request` (84–86), uploads `playwright-report` (95–101) and a PR-written `pr-meta/pr-number.txt` (116–128). Privileged consumer `e2e-report.yml` (`workflow_run`, permissions `pull-requests: write`, `pages: write`, `id-token: write`, 25–29) downloads both artifacts (48–64), trusts the artifact PR number with only digit-stripping (68–83, no match against `workflow_run.pull_requests`/head SHA), `rm -rf site/pr-${PR}` (108) and copies raw PR HTML into the site (103–121), then deploys to Pages (137–146). **The whole site round-trips through the `pages-site` artifact (87–131), so PR-controlled JS on the Pages origin persists and can poison the root and other PRs' reports** — persistent XSS on a trusted origin + comment hijack.

**Fix.** Serve untrusted reports as downloadable/sanitized inert content or on a dedicated origin with no trusted cookies; derive PR number + head SHA from the GitHub API/event, not `pr-meta`; verify head repo/SHA before publishing; bind prior-site artifacts to a specific trusted run; minimize token perms; require approval before publishing fork reports.

### M-03 — Confidential bearer tokens & intent metadata stored plaintext (Medium)

**Files:** `nt-be/migrations/20260403000001_add_confidential.sql:4–11`, `20260429000001_add_bulk_payment_tokens.sql:9–13`
**CWE:** 312

**Verified evidence.** `confidential_access_token TEXT`, `confidential_refresh_token TEXT` (and `bulk_payment_*` equivalents) stored as raw TEXT; intent data as JSONB. No app-layer encryption (`grep encrypt|aes|cipher` over `src/` = 0; no crypto crate). Only mitigation is log redaction (`observability.rs:207`). Contrast: the app's own session tokens are SHA-256 hashed, but these 1Click JWTs must be recoverable, so they sit plaintext — a DB dump/SQLi yields live 1Click credentials per confidential treasury.

**Fix.** Envelope-encrypt tokens + high-sensitivity JSON via managed KMS + AEAD with row/field context; support key rotation + audited decrypts; store hashes/derived values where plaintext isn't required; enforce a short retention/erasure lifecycle for completed/expired/abandoned intents; confirm DB/snapshot/backup encryption in the deployment env.

### M-04 — `payout_batch` panics on one malformed recipient/token → list bricked (Medium, NEW)

**Files:** `contracts/bulk-payment/src/lib.rs` (466, 479–481, 487–490)

**Verified evidence.** `payout_batch` uses panicking parses: native `recipient.parse().unwrap_or_else(panic)` (479–481), `token_id.parse().expect(...)` (487–490), `"intents.near".parse().unwrap()` (466). `submit_list` doesn't validate recipient/token well-formedness, so a single bad value panics the whole call, reverts state, and — because it's re-validated every invocation — the list can never progress (permanent DoS).

**Fix.** Validate recipient/token_id at `submit_list` time and/or skip-and-mark individual bad payments in `payout_batch` instead of panicking the batch.

### M-05 — `verify_member_if_confidential` fails open for non-monitored accounts (Medium, NEW)

**Files:** `nt-be/src/auth/middleware.rs:232–282` (fail-open at 261–268), `OptionalAuthUser` 292–295

**Verified evidence.** The confidential guard returns `Ok(false)` (allowing the read unauthenticated) when the account has no `monitored_accounts` row or `is_confidential_account` is NULL/false. So any flow that flips the confidential flag *after* ingestion, or deletes the row, silently makes history public. `OptionalAuthUser` also swallows all auth errors into `None`, losing the bad-token vs no-token distinction. No IDOR found in the guarded handlers themselves (they pass the request's account/dao into the membership check).

**Fix.** Make the confidential determination fail-closed for accounts whose status is unknown/unset where confidential data could exist; ensure flag transitions re-gate historical data; consider distinguishing revoked/expired from anonymous.

### L-01 — No browser security headers (Low)

**Files:** `nt-fe/next.config.ts:14–22`

**Verified evidence.** The only `headers()` entry is a wildcard CORS loosener on `/_next/static/*`; no CSP, X-Frame-Options/frame-ancestors, HSTS, X-Content-Type-Options, Referrer-Policy, or Permissions-Policy. `poweredByHeader` not set → `X-Powered-By: Next.js` emitted. (Live check of `trezu.app` on 17 Aug 2026 confirmed absence.)

**Fix.** Deploy a nonce/hash CSP (report-only first to inventory wallet/analytics origins), define framing policy, HSTS after subdomain check, `nosniff`, restrictive Referrer-Policy + Permissions-Policy, disable powered-by.

### L-02 — CI actions/toolchains not pinned; unfrozen installs (Low)

**Files:** `.github/workflows/*`, `render.yaml`

**Verified evidence.** Moving tags everywhere (`actions/checkout@v4`/`@v6`, `download-artifact@v4`/`@v8`, `deploy-pages@v4`, `github-script@v7`, `setup-bun@v2`, `docker/build-push-action@v6`, `release-plz/action@v0.5`, `mathieudutour/github-tag-action@v6.2`, archived `actions-rs/toolchain@v1`). `bun-version: latest` (frontend-e2e.yml:62, frontend-build.yml:32). `bun install` without `--frozen-lockfile` (frontend-e2e.yml:66, frontend-build.yml:36, render.yaml:56/148/165 — all three prod services). `dtolnay/rust-toolchain@stable` (backend-tests.yml:42, release-plz.yml:27). `cargo install sqlx-cli` without `--locked` (backend-tests.yml:95, copilot-setup-steps.yml:75). `cli-release.yml:137` curls `sh.rustup.rs | sh`.

**Fix.** Pin actions to reviewed full SHAs; pin exact Bun/Rust/tool versions; `--frozen-lockfile` in CI + all Render builds; `cargo install --locked --version`; automate reviewed dependency updates; generate SBOM/provenance.

### L-03 — Public `/api/health` leaks operational internals (Low)

**Files:** `nt-be/src/routes/mod.rs:23–89` (route registered no-auth at 94), `jobs/leadership.rs:38–55,100`

**Verified evidence.** Unauthenticated `/api/health` returns DB `pool_size`/`idle_connections`, local+global background-job snapshots, and Goldsky `cursor_block`. Leadership snapshots expose `instance_id: Uuid`, `generation`, `role`, `transitioned_at`, `acquired_at`/`heartbeat_at`/`released_at`, and `last_error` (up to 512 chars raw). `/api/jobs/health` is already admin-gated — same data class treated as sensitive there.

**Fix.** Keep public liveness to a stable boolean/status; move readiness/leadership diagnostics behind the existing admin/internal auth; never return raw errors or unique deployment identifiers publicly.

---

## Positive controls confirmed (do not regress)

JWT pins HS256 + validates expiry (`auth/jwt.rs:59–62`); sessions are SHA-256 hashed and re-checked live/unrevoked (`jwt.rs:70–74`, `middleware.rs:200–214`); auth challenges use CSPRNG, expire, atomically consumed; NEAR auth resolution pins block context with bounded recursion and no fallback after invalid proofs; confidential reads verify DAO policy membership across ~20 handlers; SQL is parameter-bound (no injection found); CORS uses exact origins with credentials; Telegram webhook secret compare is constant-time; observability redacts token names; the confidential contract's callbacks *do* use `#[private]` + inspect promise errors (the pattern the public contract is missing); CLI token storage uses a restrictive temp-file-and-persist pattern. No production credential/private key in tracked source.

## Fix order (proposed)

**Emergency — before any public bulk-payment contract holds assets**
1. C-01 — authenticate callback predecessor (FT + MT). **(FIXED — handled by CTO in production.)**
2. C-02 — gate `approve_list` to native lists / per-list escrow. **(FIXED — handled by CTO in production.)**
3. H-01 — settlement callback before marking `Paid`. **(FIXED — handled by CTO in production.)**
4. H-05 — `serde_json` for payout args. **(FIXED.)**
5. H-02 — measured storage charging + byte/count bounds + cleanup.
6. M-04 — non-panicking payout / submit-time validation.
7. Add adversarial contract tests; independent contract re-review before redeploy.

**Within 7 days**
8. H-03 — disable auto top-ups now; then server-derived storage + atomic credit reservation + idempotency + rate/value caps. **(FIXED for now.)**
9. H-04 — wallet origin/source/nonce validation; opener `targetOrigin`.
10. H-06 — triage + patch reachable critical/high deps.
11. M-01 — inbound rate/concurrency/timeout + timed HTTP client.
12. M-02 — isolate untrusted E2E reports from the trusted Pages origin.

**Within 30 days**
13. M-03 — app-layer encryption + retention for confidential records.
14. M-05 — fail-closed confidential guard for unknown-status accounts.
15. L-01 — security headers + CSP telemetry.
16. L-02 — pin CI actions/toolchains + frozen installs.
17. L-03 — minimize public health output.

## Closure checklist (per finding)

1. Code fix + regression test linked to the finding ID.
2. Security review of the changed trust boundary incl. the negative/adversarial path.
3. Deployment evidence the fixed artifact/code hash is active everywhere in scope.
4. Operational data reviewed for pre-fix exploitation where relevant.
5. Any accepted residual risk has a named owner, expiry, compensating control, and monitoring signal.

For C-01/C-02, closure additionally requires an inventory of every deployed contract (account id, code hash, upgrade authority, balances, recent callback/list/payout activity) and evidence no vulnerable instance retains accessible assets.
