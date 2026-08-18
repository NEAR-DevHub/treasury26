# Trezu Security Audit Report

**Classification:** Confidential — Security Sensitive  
**Assessment date:** 17 August 2026  
**Assessed snapshot:** `20a6077a` on branch `chore/security_fixes`  
**Assessment type:** Repository-wide source, architecture, configuration, and dependency review  
**Prepared for:** Trezu engineering and leadership

> This report contains enough detail to understand and remediate exploitable defects. Distribute it only to personnel responsible for security, deployment, and incident response until the critical and high-severity findings are fixed.

## Executive summary

The assessed Trezu snapshot has **one critical, five high, three medium, and three low-severity findings**. The most urgent issue is an authenticity failure in the public bulk-payment contract's token receiver callbacks. An attacker can call those callbacks directly, create a payment list without depositing the represented tokens, and cause the contract to pay the list from shared token balances already held by the contract. If a vulnerable version is deployed and holds fungible or multi-token assets, those assets should be considered exposed.

The public bulk-payment contract also records payouts as paid before asynchronous token transfers succeed and materially underprices storage for attacker-controlled strings. Together, these defects undermine the contract's asset and accounting integrity even after the callback-origin defect is fixed.

The backend's relayer sponsorship flow has a separate economic-abuse path: client-supplied storage estimates can cause a NEAR top-up before the signed action is accepted, failed submissions do not consume credits, and concurrent submissions do not atomically reserve credits. A valid DAO member can repeatedly or concurrently exhaust the sponsor wallet.

The wallet connector trusts `postMessage` responses without checking their origin, source window, or a request nonce. Dependency scans also identified unresolved advisories across runtime and build-time dependency graphs. The raw advisory totals require reachability triage, but several affected packages are in application-adjacent dependency chains and should not be deferred.

**Overall risk rating: Critical.** The assessed public bulk-payment contract should not hold user assets until C-01, H-01, and H-02 are remediated and independently retested.

## Immediate decisions

1. **Treat C-01 as an incident-level exposure if the public bulk-payment contract is deployed.** Inventory deployed contract account IDs, code hashes, upgrade authority, balances, and recent callback/list/payout activity. Preserve logs before changing state.
2. **Upgrade or migrate the vulnerable contract immediately.** Disabling only the frontend or backend is not a containment because the affected methods are callable directly on-chain. Move assets only through an approved, reviewed recovery procedure.
3. **Temporarily disable automatic relayer storage top-ups** until credits are atomically reserved and the required storage is derived by the server from a validated action.
4. **Avoid public disclosure of the exploit path** until deployed funds are protected and monitoring is in place.

## Finding summary

| ID | Severity | Finding | Primary impact |
|---|---|---|---|
| C-01 | Critical | Token receiver callbacks do not authenticate the calling token contract | Theft of pooled contract-held assets |
| H-01 | High | Payouts are marked paid before asynchronous transfers succeed | Permanent false payment state and lost retries |
| H-02 | High | Fixed-price storage credits accept unbounded persistent data | Contract storage exhaustion and economic loss |
| H-03 | High | Relayer top-ups occur before submission and credits are not atomically reserved | Sponsor-wallet drain and credit overspend |
| H-04 | High | Wallet `postMessage` responses lack origin, source, and nonce validation | Spoofed sign-in and operation results |
| H-05 | High | Known vulnerable dependencies remain across major components | DoS, memory safety, parsing, and supply-chain risk |
| M-01 | Medium | Public API lacks explicit global admission controls and outbound deadlines | DB/RPC/thread exhaustion and cascading failure |
| M-02 | Medium | Privileged workflow publishes pull-request-controlled HTML to GitHub Pages | Same-origin active content and report tampering |
| M-03 | Medium | Confidential bearer tokens and intent metadata are stored in plaintext | High-impact disclosure after DB/backup compromise |
| L-01 | Low | Browser security headers are absent from the live frontend | Reduced XSS and clickjacking defense in depth |
| L-02 | Low | CI actions and build tools are not immutably/reproducibly pinned | Build compromise and non-reproducible releases |
| L-03 | Low | Public health endpoint exposes operational internals | Reconnaissance and deployment-state disclosure |

## Scope and methodology

The review covered the source and configuration present in the assessed Git snapshot, including:

- `nt-be`: Rust/Axum API, authentication, authorization, relayer, jobs, database access, integrations, logging, and migrations.
- `nt-fe`: Next.js frontend, wallet connector, browser storage, API clients, and build configuration.
- `nt-cli`: Rust CLI authentication and local configuration handling.
- `contracts/bulk-payment`: public NEAR bulk-payment contract and tests.
- `contracts/confidential-bulk-payment`: confidential payment contract and tests.
- Goldsky pipeline definitions and SQL transforms.
- GitHub Actions, Render, sandbox, test tooling, example environments, and repository-level configuration.
- Rust and JavaScript lockfiles using the available ecosystem advisory scanners.

Methods included trust-boundary mapping, manual data-flow and authorization review, asynchronous smart-contract state analysis, secret-pattern and sensitive-file review, dynamic SQL and process-execution review, dependency advisory scans, test execution, and live response-header inspection for `trezu.app`.

Severity reflects demonstrated or reasonably likely impact in Trezu's architecture, not only a scanner's upstream label. Findings are considered **confirmed in the assessed source** unless the finding explicitly describes deployment-dependent exposure.

## Detailed findings

### C-01 — Token receiver callbacks do not authenticate the calling token contract

**Severity:** Critical  
**Category:** CWE-345 (Insufficient Verification of Data Authenticity), CWE-284 (Improper Access Control)  
**Affected component:** `contracts/bulk-payment/src/lib.rs`

#### Evidence

- `ft_on_transfer` (approximately lines 603–665) accepts caller-controlled `sender_id`, `amount`, and `msg`, validates list fields, and approves the list without requiring `env::predecessor_account_id()` to equal the list's configured NEP-141 token contract.
- `mt_on_transfer` (approximately lines 779–891) does not validate that the predecessor is the canonical multi-token contract (`intents.near`) and explicitly ignores supplied ownership/sender fields.
- `submit_list` (approximately lines 232–313) is public and permits a storage-credit holder to create a list.
- `payout_batch` (approximately lines 394–533) is permissionless and transfers assets from the contract's shared balances after a list is approved.

#### Impact

An attacker can create a recipient-controlled list and directly invoke the receiver callback without transferring the represented tokens. The forged callback moves the list into an approved state, after which the attacker can trigger payouts funded by unrelated fungible or multi-token balances held by the contract. Exploitation is low complexity and does not require a privileged key.

The maximum loss is the contract's accessible balance of each token type, bounded only by the lists and payout batching an attacker can submit.

#### Required remediation

1. In `ft_on_transfer`, parse and compare the predecessor account to the exact token contract recorded for the list. Reject every mismatch before mutating state.
2. In `mt_on_transfer`, require the exact canonical multi-token predecessor and validate the authoritative sender/previous-owner semantics expected from that standard.
3. Do not rely only on a callback's serialized arguments as proof that a transfer occurred.
4. Isolate escrow/accounting per payment list rather than treating the contract's entire token balance as fungible across lists.
5. Add invariant tests that directly call both callbacks from an attacker predecessor and verify rejection without any state change.

#### Retest criteria

- Direct callback calls from an arbitrary account fail for FT and MT paths.
- A transfer from the wrong token contract fails even if symbol, amount, sender, and message are otherwise valid.
- A legitimate transfer credits only that list's escrow, and payouts cannot exceed its credited balance.
- Tests cover replays, mismatched list IDs, mismatched amounts, and forged sender fields.

### H-01 — Payouts are marked paid before asynchronous transfers succeed

**Severity:** High  
**Category:** CWE-252 (Unchecked Return Value), distributed-state integrity failure  
**Affected component:** `contracts/bulk-payment/src/lib.rs`

#### Evidence

`payout_batch` creates and detaches external FT/MT transfer promises at approximately lines 447–505. It then immediately sets the associated payment status to `Paid` at approximately lines 507–510. There is no private completion callback that inspects `PromiseResult` and reconciles the payment state.

#### Impact

NEAR cross-contract receipt failure does not roll back the source contract's earlier state transition. An unregistered recipient, malformed recipient, downstream rejection, insufficient gas, paused token contract, or other transfer failure therefore produces a permanently false `Paid` record. The recipient is unpaid, while normal retry logic can no longer select the payment.

This damages payment integrity and audit history and can strand funds in the contract.

#### Required remediation

- Introduce an `InFlight` state and unique attempt ID before dispatch.
- Chain every transfer to a `#[private]` callback that inspects the promise result.
- Mark `Paid` only after successful completion; return a failed attempt to `Pending` or a retryable `Failed` state.
- Prevent concurrent dispatch of an in-flight payment and make callbacks idempotent.
- Record the transaction/receipt reference needed for reconciliation.

#### Retest criteria

Force downstream transfer failures for both FT and MT paths and verify that payments never become `Paid`, remain safely retryable, and cannot be double-dispatched.

### H-02 — Fixed-price storage credits accept unbounded persistent data

**Severity:** High  
**Category:** CWE-400 (Uncontrolled Resource Consumption)  
**Affected component:** `contracts/bulk-payment/src/lib.rs`

#### Evidence

- Storage is priced using a fixed estimate of approximately 216 bytes per record plus a 10% margin (approximately lines 118–152).
- `PaymentInput.recipient` and list `token_id` are attacker-controlled strings without contract-level byte limits.
- `submit_list` persists the complete values and does not enforce the backend's 25-payment limit.
- Rejection changes status but does not delete the stored list, and no safe storage-reclamation path was found.

#### Impact

A caller can buy a small, fixed amount of storage credit and persist values that consume far more storage than was paid for. Repetition can lock the contract's NEAR balance against state storage, prevent legitimate writes, and create lasting operational loss. Backend validation is not a security boundary because the contract methods are public.

#### Required remediation

- Prefer charging the exact before/after `env::storage_usage()` delta for each write, including collection overhead.
- Enforce strict byte-length limits for token IDs and recipient values and a contract-level maximum number of payments per list.
- Refund or debit exact deltas and fail atomically when the caller has insufficient credit.
- Add a reviewed cleanup/reclamation lifecycle with ownership and list-state checks.
- Correct architecture documentation that currently implies cleanup exists.

#### Retest criteria

Property tests should vary UTF-8 string lengths and list sizes, prove that paid storage always covers measured storage, and confirm that rejected/completed records can be reclaimed without deleting active obligations.

### H-03 — Relayer top-ups occur before submission and credits are not atomically reserved

**Severity:** High  
**Category:** CWE-362 (Race Condition), CWE-770 (Allocation of Resources Without Limits)  
**Affected components:** `nt-be/src/handlers/relay/submit.rs`, `nt-be/src/handlers/relay/policy.rs`, `nt-be/src/handlers/relay/accounting.rs`, `nt-be/src/handlers/relay/access.rs`

#### Evidence

- The API accepts a client-supplied `storage_bytes` value and permits values up to 4,000 bytes.
- The sponsor transfer is calculated from that value—up to approximately 0.04 NEAR per request—and sent to the DAO before the signed action is submitted successfully.
- If the later relay submission fails, sponsor spend is recorded but the user's credit is not consumed.
- Authorization reads available credits before submission, while credit consumption occurs asynchronously afterward without an atomic reservation/row lock.
- Public monitored-account registration can create an initial Plus entitlement for new account-shaped DAO rows, subject only to the configured suffix and subsequent membership checks.

#### Impact

An authorized member of a DAO they control can repeatedly request the maximum storage top-up and deliberately provide an action that fails after the top-up. Because failure does not consume a credit, the pattern can be repeated to drain the relayer sponsor wallet. Independently, concurrent successful requests can all observe the same available credit before delayed accounting decrements it.

#### Required remediation

1. Derive required storage from the decoded and validated action on the server; never trust a caller-provided byte count for reimbursement.
2. Fully parse, bind, and preflight the signed action before any sponsor spend.
3. Reserve or decrement a credit in the same database transaction that creates a unique relay attempt. Use row locking or a conditional atomic update.
4. Charge any attempt that caused an on-chain sponsor transfer, even if the later relay fails.
5. Add idempotency keyed by the signed-action hash and prevent replayed top-ups.
6. Add per-user, per-DAO, and sponsor-wallet rate/value limits and alert on anomalous spend.
7. Reconcile `paid_near`, reserved credits, and final transaction state with a durable job.

#### Retest criteria

Parallel submissions with one remaining credit must permit only one reservation. A malformed/rejected action must never trigger a top-up, and retrying an action hash must not transfer value twice.

### H-04 — Wallet `postMessage` responses lack origin, source, and nonce validation

**Severity:** High  
**Category:** CWE-346 (Origin Validation Error)  
**Affected components:** `nt-fe/near-connect/src/trezu-wallet.ts`, `nt-fe/app/wallet/utils/opener.ts`

#### Evidence

- The connector opens a configured Trezu wallet URL but its message handler accepts `trezu:*` messages without checking `event.origin` or `event.source` (approximately lines 245–370).
- The sign-in callback persists the returned `accountId` to local storage and reports success without a request-bound state/nonce check (approximately lines 108–124).
- The wallet-side opener sends results to `window.opener` with a target origin of `"*"`.

#### Impact

A malicious page with a window reference can forge sign-in, pending, or completion messages during a wallet flow. This can spoof the connected account and transaction outcome in an integrating dApp. The review did not demonstrate direct private-key or signature extraction, but the defect crosses the wallet authentication and operation-integrity boundary.

#### Required remediation

- Derive and pin the exact expected wallet origin.
- Require `event.origin === expectedOrigin` and `event.source === openedPopup`.
- Generate a cryptographically random, single-use request nonce/state and require it in every response.
- Validate each message with a strict discriminated schema and reject unsolicited or duplicate results.
- Use the exact, validated callback origin as `targetOrigin`; never use `"*"` for credential or transaction messages.

#### Retest criteria

Messages from the wrong origin, wrong window, stale request, duplicate request, or invalid schema must be ignored. A legitimate popup round trip must remain functional.

### H-05 — Known vulnerable dependencies remain across major components

**Severity:** High  
**Category:** CWE-1104 (Use of Unmaintained Third-Party Components)  
**Affected components:** JavaScript and Rust dependency graphs

#### Evidence

The available scanners reported:

| Dependency graph | Scanner result |
|---|---|
| `nt-fe` | 80 advisories across 22 package names: 1 critical, 40 high, 36 moderate, 3 low |
| `nt-fe/near-connect` | 0 advisories |
| `e2e-tests/bulk-payment` production graph | 13 advisories: 1 moderate, 12 low |
| `nt-be` | 7 RustSec vulnerabilities plus unmaintained/unsound/yanked warnings |
| `nt-cli` | 3 RustSec vulnerabilities plus warnings |
| `contracts/bulk-payment` | 2 RustSec vulnerabilities plus warnings, primarily in native test/build dependencies |
| `contracts/confidential-bulk-payment` | 2 RustSec vulnerabilities plus warnings, primarily in native test/build dependencies |
| `sandbox` | 9 RustSec vulnerabilities plus warnings |
| `contracts/confidential-bulk-payment/mock-mpc` | 0 RustSec vulnerabilities; one unmaintained allocator warning |

Notable JavaScript reports include critical/high `tar` parsing/decompression issues through the NEAR Intents/Omni Bridge dependency chain, high-severity advisories in optional `@solana/web3.js` and `bigint-buffer`, and affected versions of `fast-uri`, transitive `axios`, `serialize-javascript`, and `ws`.

Notable Rust reports include `quinn-proto` remote memory exhaustion and multiple `rustls-webpki` advisories in the backend graph, `rkyv` out-of-bounds read in the CLI graph, and `bytes`, `tar`, `time`, `rsa`, and `rustls-webpki` advisories in sandbox tooling. The `rsa` Marvin timing advisory has no upstream fixed release and requires architectural mitigation or replacement.

#### Impact

Potential impacts include denial of service, parser confusion, memory safety faults, cryptographic side channels, and build-time code execution. Scanner counts include transitive, optional, development, and target-specific packages, so not every advisory is reachable in production. However, the presence of critical/high issues in application-adjacent chains and network-facing Rust dependencies warrants high-priority ownership and reachability analysis.

#### Required remediation

- Produce a per-advisory reachability matrix: runtime/build/test, imported feature, attacker-controlled input, deployed target, fixed version, and owner.
- Upgrade or override the NEAR Intents/Omni Bridge chain to remove vulnerable archive/parser and Solana packages.
- Update backend TLS/QUIC dependencies and assess whether the affected QUIC path is enabled.
- Replace or isolate the unfixed RSA usage where secrets and attacker-observable timing coexist.
- Upgrade the CLI's `rkyv` chain and sandbox-only vulnerable packages.
- Add blocking `cargo audit` and production-focused package audits to CI with documented, expiring exceptions.

### M-01 — Public API lacks explicit global admission controls and outbound deadlines

**Severity:** Medium  
**Category:** CWE-400, CWE-770  
**Affected components:** `nt-be/src/main.rs`, `nt-be/src/app_state.rs`, public route handlers

#### Evidence

The top-level Axum router applies CORS, tracing, and Sentry layers but no explicit global rate, concurrency, or request-deadline layer. Axum's normal JSON body behavior still applies; this finding does not assert that every request body is unbounded.

The shared `reqwest::Client` is built with `Client::new()` and therefore has no application-defined total request timeout. Many public handlers invoke RPC, DB, or external services, including the proxy catch-all, auth challenge/login, monitored-account registration, gap filling, proposal refresh, intents, and token metadata. Some operations have local cooldowns, but no coherent admission-control boundary was found. Unknown-account auth resolution can retry with exponential delays.

#### Impact

Low-cost request floods or deliberately slow upstreams can exhaust database connections, RPC capacity, async tasks, memory, or external-service quotas and can create cascading availability failures.

#### Required remediation

- Apply edge and application-level token buckets by IP, authenticated account, DAO, and endpoint cost.
- Add global and endpoint-specific concurrency limits and deadlines.
- Build the HTTP client with connect, request, idle, and response-size limits.
- Queue expensive repair/refresh work and deduplicate equivalent jobs.
- Move challenge expiry cleanup to a scheduled job and limit outstanding challenges per subject/IP.
- Add metrics for rejected, queued, timed-out, and upstream-saturated requests.

### M-02 — Privileged workflow publishes pull-request-controlled HTML to GitHub Pages

**Severity:** Medium  
**Category:** CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)  
**Affected components:** `.github/workflows/frontend-e2e.yml`, `.github/workflows/e2e-report.yml`

#### Evidence

The pull-request workflow checks out and runs PR-controlled code, then uploads `playwright-report` and `pr-meta` artifacts. A privileged `workflow_run` workflow with pull-request write, Pages, and OIDC permissions downloads those artifacts, trusts the artifact-provided PR number, places the raw HTML report into the Pages site, deploys it, and posts a bot comment.

Although the privileged workflow does not execute the PR's code, it publishes PR-controlled active content on the repository's Pages origin. The previous shared Pages artifact retrieval is also not strongly bound to the originating trusted workflow/run.

#### Impact

A malicious pull request can publish arbitrary HTML/JavaScript on a trusted project-associated origin, choose another PR's report path via metadata, overwrite that report, and cause the bot to link to it. This creates phishing, origin-trust, and integrity risk.

#### Required remediation

- Serve untrusted reports as downloadable archives or sanitized inert content, or place them on a dedicated origin with no trusted cookies or origin assumptions.
- Derive the PR number and head SHA from the GitHub API/workflow event; do not trust `pr-meta`.
- Verify the head repository and SHA before publishing.
- Bind prior-site artifacts to a specific trusted workflow and successful run.
- Minimize token permissions and require explicit approval before publishing reports from forks.

### M-03 — Confidential bearer tokens and intent metadata are stored in plaintext

**Severity:** Medium  
**Category:** CWE-312 (Cleartext Storage of Sensitive Information)  
**Affected components:** confidential migrations and intent/relay services

#### Evidence

`nt-be/migrations/20260403000001_add_confidential.sql` stores confidential access and refresh tokens as `TEXT` and intent data as `JSONB`. Later migrations add quote metadata, deposit addresses, payment details, and related fields. The application reads these values directly and no application-layer envelope encryption, field encryption, or retention/deletion lifecycle was found.

The API's confidential-account access control is a positive control: protected reads use `verify_member_if_confidential` and verify DAO policy membership. This finding concerns data at rest after a database, backup, log, or administrator boundary is crossed.

#### Impact

A database read compromise exposes reusable bearer credentials and a detailed graph of confidential quotes, deposits, recipients, notes, and payment activity. Infrastructure-level disk encryption alone does not protect against logical SQL access or leaked backups.

#### Required remediation

- Envelope-encrypt tokens and high-sensitivity JSON fields using a managed KMS and authenticated encryption with row/field context.
- Support key rotation and audited decrypt operations.
- Store hashes or derived values instead of raw credentials wherever validation does not require plaintext.
- Define and enforce a short retention/erasure lifecycle for completed, expired, and abandoned intents.
- Confirm database, snapshot, and backup encryption/access controls in the deployment environment.

### L-01 — Browser security headers are absent from the live frontend

**Severity:** Low  
**Category:** CWE-693 (Protection Mechanism Failure)  
**Affected component:** `nt-fe/next.config.ts` and frontend hosting configuration

#### Evidence

The Next.js configuration defines static JavaScript CORS behavior but no Content Security Policy, `frame-ancestors`/X-Frame-Options, HSTS, `X-Content-Type-Options`, Referrer-Policy, or Permissions-Policy. A live header check of `https://trezu.app` on 17 August 2026 confirmed the absence of those controls and disclosed `x-powered-by: Next.js`.

#### Required remediation

Deploy a tested nonce/hash-based CSP, explicitly define framing policy, enable HSTS after verifying all subdomains, set `nosniff`, a restrictive Referrer-Policy and Permissions-Policy, and disable the powered-by header. Roll out CSP in report-only mode first to inventory required wallet and analytics origins.

### L-02 — CI actions and build tools are not immutably/reproducibly pinned

**Severity:** Low  
**Category:** CWE-1104, CWE-829  
**Affected components:** `.github/workflows/*`, Render build configuration

#### Evidence

Workflows reference moving action tags such as `actions/checkout@v4`/`@v6`, `setup-bun@v2`, and `dtolnay/rust-toolchain@stable` rather than full commit SHAs. Some builds use `bun-version: latest`, run `bun install` without a frozen-lockfile flag, or install Rust CLI tooling without an exact version/locked dependency set.

#### Required remediation

Pin third-party actions to full reviewed SHAs, pin exact Bun/Rust/tool versions, enforce frozen lockfiles, use `cargo install --locked --version ...`, and automate reviewed dependency updates. Generate provenance/SBOMs for release artifacts.

### L-03 — Public health endpoint exposes operational internals

**Severity:** Low  
**Category:** CWE-200 (Exposure of Sensitive Information)  
**Affected components:** `nt-be/src/routes/mod.rs`, `nt-be/src/jobs/leadership.rs`

#### Evidence

`/api/health` is public and returns database pool size/idle counts, local role, instance UUID, generation/transitions, recent leadership error state, global instance/heartbeat details, and Goldsky cursor information. The separate detailed jobs health endpoint is admin-protected, which is the preferable model.

#### Required remediation

Keep public liveness to a stable boolean/status and expose readiness and leadership diagnostics only on an authenticated internal/admin endpoint. Avoid returning raw recent errors or unique deployment identifiers publicly.

## Positive security controls observed

The review also confirmed several sound controls:

- JWT verification pins HS256, validates expiry, and backs tokens with hashed server-side sessions.
- Session cookies are configured Secure, HttpOnly, and SameSite=Strict.
- Authentication challenges use cryptographic randomness, expire, and are atomically consumed.
- NEAR authorization resolution pins the block context and has bounded recursion without falling back after invalid proofs.
- Confidential-account reads consistently verify DAO policy membership.
- SQL queries are predominantly parameter-bound; reviewed dynamic fragments were constants. No confirmed SQL injection was found.
- CORS uses configured exact origins when credentials are enabled.
- Telegram webhook secret comparison is constant-time.
- Observability code has token-name redaction and associated tests.
- The confidential contract's asynchronous callbacks use private callbacks and inspect promise errors.
- CLI bearer-token storage uses a restrictive temporary-file-and-persist pattern.
- No production credential or private key was confirmed in tracked source. Tracked deterministic keys were confined to documented examples, sandbox, fixtures, or tests.

These controls reduce risk but do not compensate for the contract and relayer findings above.

## Remediation roadmap

### Emergency — before further public-contract use

- Protect deployed assets and remediate C-01.
- Implement promise-result accounting for H-01.
- Replace fixed storage pricing and impose contract-level bounds for H-02.
- Add adversarial contract tests and obtain an independent smart-contract review before redeployment.
- Disable relayer top-ups until H-03's reservation and validation model is implemented.

### Within 7 days

- Fix wallet message origin/source/nonce validation.
- Triage and patch reachable critical/high dependencies.
- Add sponsor spend alarms, replay detection, and value caps.
- Put public API rate/concurrency/timeout controls in front of expensive routes.
- Isolate untrusted E2E reports from the trusted Pages origin.

### Within 30 days

- Introduce application-layer encryption and retention controls for confidential records.
- Deploy browser security headers with CSP telemetry.
- Pin CI actions/toolchains and enforce frozen dependency resolution.
- Minimize public health output.
- Add automated secret scanning, dependency policy gates, SBOM/provenance generation, and periodic security regression tests.

## Validation performed

| Validation | Result |
|---|---|
| Public bulk-payment unit tests | 16 passed |
| Public bulk-payment integration tests | 11 blocked before assertions because `cargo-near` is not installed |
| Confidential bulk-payment unit tests | 9 passed |
| Confidential bulk-payment integration tests | 6 blocked before assertions because `cargo-near` is not installed |
| `nt-fe` package audit | Completed; raw results summarized in H-05 |
| `nt-fe/near-connect` package audit | Completed; no advisories reported |
| Bulk-payment E2E production package audit | Completed; raw results summarized in H-05 |
| Rust lockfile audits | Completed for backend, CLI, both contracts, sandbox, and mock MPC |
| Live frontend response-header inspection | Completed on 17 August 2026 |
| CLI test suite | 12 passed |

The passing contract unit suites do not include tests that reject a direct forged FT/MT callback or reconcile a failed payout promise. Passing existing tests therefore does not contradict C-01 or H-01.

## Assessment limitations

- This was a broad repository audit, not a mathematical proof or exhaustive line-by-line formal verification of approximately 769,000 repository lines (including generated locks and fixtures).
- Deployed contract account IDs, on-chain code hashes/state, upgrade keys, balances, and historical transactions were not supplied or verified. Actual exposure of deployed assets must be established operationally.
- Production cloud IAM, database configuration, KMS, secret manager, DNS/CDN/WAF, GitHub environment protections, and third-party dashboards were outside the repository evidence available.
- No destructive or exploit transaction was sent to a live environment.
- Backend integration tests requiring a configured PostgreSQL/external-service environment were not run as part of this static audit.
- Contract sandbox integration tests could not start because the required `cargo-near` executable is absent.
- Dependency advisories are lockfile-based. Optional features, deployed targets, and code-path reachability require the follow-up triage described in H-05.
- The secret review covered tracked source and sensitive filename/pattern checks; it was not a complete entropy scan of every historical Git object. If any example/test key was ever reused outside testing, rotate it.

## Closure requirements

A finding should be closed only after:

1. A code fix and regression test are linked to the finding ID.
2. Security reviews the changed trust boundary and tests the negative/adversarial path.
3. Deployment evidence confirms the fixed artifact/code hash is active everywhere in scope.
4. Operational data is reviewed for pre-fix exploitation where relevant.
5. Any accepted residual risk has a named owner, expiry date, compensating control, and monitoring signal.

For C-01, closure additionally requires an inventory of every deployed vulnerable contract and evidence that no vulnerable instance retains accessible assets.
