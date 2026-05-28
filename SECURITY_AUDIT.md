# Security Audit Report — Treasury26 / Trezu

**Audit date:** 2026-05-27
**Scope:** Full monorepo at commit `d9cc4d7` on `fix/dashboard-address-overflow`. Surfaces covered: NEAR `bulk-payment` contract, Rust backend (`nt-be`), Next.js frontend (`nt-fe`), Rust CLI (`nt-cli`), CI/CD workflows (`.github`), deploy config (`render.yaml`), sandbox (`sandbox/`), Goldsky pipelines (`goldsky/`), E2E tests (`e2e-tests/`), and all dependency manifests.
**Method:** Seven parallel exploration agents (per-surface), followed by direct verification of all Critical/High findings against the source code. Findings without a verified file:line evidence have been demoted or removed.

---

## Executive Summary

The application has a number of **critical on-chain authorization bugs** in the `bulk-payment` NEAR contract that would allow an attacker to approve and lock funds without depositing the correct token, and to lose funds permanently on payout failures. The **backend trust boundary leaks JWTs to stdout** in a confidential-intent code path, and the **frontend login flow has an exploitable open redirect**. The **CI/CD posture is weak**: most workflows omit a top-level `permissions:` block (default-write in a private repo), no artifact signing/provenance, and one third-party action is tag-pinned. **Secrets management is generally good** — no production secrets are tracked in git; the only tracked `.env*` files are example/test files containing public NEAR sandbox keys.

Severity counts after verification: **5 Critical**, **13 High**, **15 Medium**, **11 Low**.

The single highest priority is the contract: it custodies DAO funds and the two callback handlers (`ft_on_transfer`, `mt_on_transfer`) accept input without verifying the caller, which is the canonical NEP-141/NEP-245 vulnerability.

---

## Critical Findings (fix before next deploy)

### C1. Token-callback spoofing in `ft_on_transfer` — approves lists with no actual deposit
**File:** `contracts/bulk-payment/src/lib.rs:604-661`
**Verified:** Yes (read 580-661).

The handler reads `sender_id` and `amount` from arguments but never checks `env::predecessor_account_id()`. Any account on NEAR can call `ft_on_transfer` directly, passing `sender_id = <list submitter>`, `amount = <expected total>`, `msg = <list_id>`. The contract will set the list to `Approved` (line 650) without any tokens having moved.

Once approved, `payout_batch` will send real tokens out of any balance the contract already holds for that `token_id`. If the contract pools balances across lists (which it does — no per-list escrow), an attacker can drain another list's deposit.

**Fix:** Require `env::predecessor_account_id() == list.token_id.parse::<AccountId>()` (and reject the `nep141:`/`native` prefixes that aren't a real contract).

### C2. Token-callback spoofing in `mt_on_transfer` — same class, multi-token side
**File:** `contracts/bulk-payment/src/lib.rs:691-776`
**Verified:** Yes. Line 700 explicitly drops the caller info: `let _ = (previous_owner_ids, sender_id);`. No `predecessor_account_id` check anywhere.

Same exploit as C1 against intents-backed lists. Comment at line 720 ("We allow token owners to approve lists even if they didn't submit them") is misleading — there's no token-owner check either, just no check at all.

**Fix:** Require `env::predecessor_account_id() == "intents.near".parse().unwrap()` (or whatever multi-token contract is configured), plus a token-id-match check.

### C3. `payout_batch` marks payments `Paid` before the cross-contract call resolves; `.detach()` discards failures
**File:** `contracts/bulk-payment/src/lib.rs:469, 480, 500, 503-507`
**Verified:** Yes (read 420-540).

For every transfer path (intents `ft_withdraw`, native NEAR, NEP-141 `ft_transfer`) the Promise is created with `.detach()` and the payment is immediately marked `Paid { block_height }`. There is no `.then()` callback that observes success/failure.

Consequence: if a transfer panics on the receiver (invalid recipient, unregistered storage, paused token, insufficient gas downstream), funds stay in the contract but the list shows the payment as complete. Combined with the fact that `reject_list` rejects only `Pending` lists (line 547) and **no `withdraw`/`refund` method exists anywhere** (grepped), the deposit is permanently locked.

**Fix:** Use `.then()` with a `finalize_payment` callback that flips status to `Paid` only on success and to `Failed`/`Pending` on failure. Add a `refund_failed` path for the submitter.

### C4. Login open redirect via protocol-relative URL
**File:** `nt-fe/app/(treasury)/login/page.tsx:19-23, 51-53`
**Verified:** Yes (read 1-60).

```ts
function sanitizeReturnTo(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  return raw;
}
```

`//evil.com/steal` starts with `/` and passes the check. `appendUtmParamsToReturnTo` returns the raw string unchanged when no UTM params are present (line 39), and `router.replace("//evil.com/...")` does a cross-origin navigation. With UTMs present, the host is stripped — but the no-UTM branch is the easy exploit.

Phishing payload: `https://app.trezu.app/login?returnTo=//evil.example.com/`. After the user authenticates, they land on attacker-controlled origin still trusting the brand context.

**Fix:**
```ts
if (raw.startsWith("//") || raw.includes(":") || !raw.startsWith("/")) return "/";
```

### C5. JWT/auth-response body printed to stdout in confidential-intent handler
**File:** `nt-be/src/handlers/intents/confidential/mod.rs:137`
**Verified:** Yes — `println!("json_value: {:?}", json_value);` immediately after parsing a 1Click auth refresh response that contains access/refresh tokens. In Render's production environment, stdout is captured into the logs surface and retained.

**Fix:** Delete the line, or replace with `tracing::debug!` gated to non-prod and redacting token fields.

---

## High Findings

### H1. No refund/withdraw path; combined with C3 = guaranteed fund loss on any transfer failure
**File:** `contracts/bulk-payment/src/lib.rs` (entire file — grepped, no matching method exists).

`reject_list` only flips status (no transfer) and only works on `Pending`. The README mentions a method to clean storage of rejected proposals but the contract has no such method. Once funds enter the contract via the spoofable callbacks, only `payout_batch` can move them — and only forward.

### H2. Submitter can self-approve via `approve_list`
**File:** `contracts/bulk-payment/src/lib.rs:322-325` (per agent report).

Direct `approve_list` succeeds when `caller == list.submitter`. Per the architecture document, approval should be DAO-vote-gated (transfer-call from the DAO). The presence of a self-approve path means an attacker who bypasses the BE doesn't even need to spoof a callback (C1/C2) to set `Approved` — they can just call the method directly with their own list.

### H3. Unbounded payment list size — gas DoS on `payout_batch`
**File:** `contracts/bulk-payment/src/lib.rs:376-380` (per agent report). README acknowledges ~250-record practical limit but `submit_list` enforces no upper bound.

### H4. Contract assumes hash-to-list-content binding but never verifies it
**File:** `contracts/bulk-payment/src/lib.rs:228-309`. `list_id` is validated as 64-hex; SHA-256(payment-payload) match is asserted only by `nt-be/src/handlers/bulkpayment/submit.rs:111-165`. If anyone bypasses the BE (and the contract permits direct calls), `list_id` is uncorrelated with `payments` content.

### H5. Backend `/api/user/create` is unauthenticated and spends backend funds
**File:** `nt-be/src/main.rs:328-335` (per agent report). Endpoint creates funded NEAR accounts via the backend signer with `open_cors` and no auth — trivial griefing/fund drain.

### H6. Hash canonicalization risk between FE/BE/contract
**File:** `nt-be/src/handlers/bulkpayment/submit.rs:111-165`. The agent flagged that ordering and type-encoding (string vs number for `amount`) of JSON fields is not strictly canonicalized; mismatches between FE-computed hash and BE-recomputed hash will reject legitimate lists, and any difference between BE and contract semantics would allow content-substitution within a single hash. Recommend a single canonical encoder used by FE/BE/contract.

### H7. Missing nonce-replay protection on relayed delegate actions
**File:** `nt-be/src/handlers/relay/submit.rs:334-620`. Backend decodes and signs/relays `SignedDelegateAction`s without storing submitted nonces. NEAR's chain-level nonce check prevents on-chain replay against the same signer + account, but the relayer can be tricked into spending its gas budget repeatedly for the same action. Track `(sender_id, public_key, nonce)` server-side with TTL.

### H8. Auth challenge nonce not bound to an account
**File:** `nt-be/src/auth/handlers.rs:52-81`. `create_challenge` inserts `account_id = ''`. Any account can subsequently solve any unbound challenge. Bind the nonce to the requesting account at issuance and verify at solve time.

### H9. Confidential 1Click access/refresh tokens stored in plaintext
**File:** `nt-be/src/handlers/relay/confidential.rs:346-360`. `monitored_accounts.confidential_access_token` and `confidential_refresh_token` are written as-is. A DB-read primitive (SQL injection, backup leak, ops mistake) directly yields impersonation across every monitored DAO.

### H10. SSRF in proxy endpoint via path traversal
**File:** `nt-be/src/handlers/proxy/external.rs:24-68`. `path` is interpolated into `format!("{}/{}", base_url, path)`; `..` segments and a leading `/` allow probing other paths and arbitrary URLs that resolve relative to `base_url`. Whitelist allowed sub-paths and reject `..` / control chars.

### H11. Frontend Chart component injects CSS from config via `dangerouslySetInnerHTML`
**File:** `nt-fe/components/ui/chart.tsx:82-102`. `color` values from chart config are emitted into a `<style>` block without validation. If a `color` ever flows from API data (e.g., chain/token metadata), CSS-injection escalates to data exfil via `background: url(...)` patterns. Validate against a strict color regex or move to inline `style={}` (auto-encoded by React).

### H12. CI workflows lack a top-level `permissions:` block — private-repo default is write-all
**Files:** `.github/workflows/{backend-tests,bulk-payment-e2e,bulk-payment-test,copilot-setup-steps,frontend-build,frontend-e2e}.yml`. In a private repo the default `GITHUB_TOKEN` is write to everything. Add `permissions: contents: read` at workflow level, with explicit narrower grants per job.

### H13. Hardcoded test credentials baked into the published sandbox container image
**File:** `sandbox/supervisord.conf:37` (also Dockerfile `EXPOSE 5432`). The sandbox image published to GHCR bakes `SIGNER_KEY`, `BULK_PAYMENT_SIGNER`, `JWT_SECRET=sandbox-jwt-secret-for-testing` and DB creds. Anyone who runs that image (intentional or accidental — wrong tag in `render.yaml`, dev machine exposed) inherits all of them. The keys are labelled "test", but the image is publicly pullable. The mock server's `/_test/sign-delegate-action` will sign any delegate with the genesis key, with no auth, on `0.0.0.0:4000`. Treat the image as confidential or move all secrets to runtime env.

---

## Medium Findings

### M1. State mutation before cross-contract call in `payout_batch` (companion to C3)
Storage credits are also mutated before any Promise resolves; if a payment fails, credit accounting is also wrong. (`contracts/bulk-payment/src/lib.rs:184-196, 260-278`.)

### M2. Confused unit semantics in `storage_credits` (NearToken used as a record counter)
`contracts/bulk-payment/src/lib.rs:184-196, 260-278`. Storage credits are stored as `NearToken::from_yoctonear(count)` and compared via `.as_yoctonear()`. Math works today but invites a unit bug on the next change. Replace with a `u64` counter.

### M3. No upfront validation of `recipient` strings in `submit_list`
`contracts/bulk-payment/src/lib.rs:470-500`. Invalid recipients only fail at payout. Combined with C3, those payments get marked `Paid` and stuck.

### M4. Query-builder returns raw SQL string with caller-managed bind ordering
`nt-be/src/handlers/balance_changes/query_builder.rs:259-294`. sqlx still parameterizes the values, so this isn't classic SQL injection, but a mismatch between condition list and bind list (easy to introduce on refactor) will cause runtime errors or wrong row sets. Convert to a struct that owns both.

### M5. Confidential-DAO membership check is read-once, not enforced at data-access time
`nt-be/src/auth/middleware.rs:216-266`. TOCTOU window between membership check and the downstream query; in practice short, but worth re-checking inside the data query (e.g., via a JOIN on `dao_members`) for sensitive endpoints.

### M6. Hardcoded Gleap project token in client bundle
`nt-fe/components/gleap-widget.tsx:11`. Public project tokens are by design client-visible but should at least be `NEXT_PUBLIC_GLEAP_TOKEN` so rotation doesn't require a code change. Confirm Gleap project has origin restrictions and rate limits.

### M7. Theme-init `<script dangerouslySetInnerHTML>` + unguarded `JSON.parse`
`nt-fe/app/(treasury)/layout.tsx:80-96`. Static content today, but `JSON.parse(localStorage.getItem(...))` without try/catch will crash the inline script and any subsequent inline scripts will not run. Wrap and validate via Zod or replace with `next/script strategy="beforeInteractive"`.

### M8. No CSP / frame-ancestors / Referrer-Policy headers
`nt-fe/next.config.ts`. No `headers()` block. Add a strict `Content-Security-Policy`, `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`), and `Referrer-Policy: strict-origin-when-cross-origin`. Especially important given C4 (open redirect) and inline-style injection points.

### M9. Wallet account id in `localStorage` rather than HttpOnly cookie
`nt-fe/near-connect/src/trezu-wallet.ts:74-91`. Account id isn't a credential, but having anything auth-relevant readable by XSS reduces defence in depth.

### M10. Missing rate limiting on heavy endpoints (`/api/balance-changes`, `/api/balance-history/export`, `/api/user/assets`)
`nt-be/src/routes/mod.rs:82-250`. Add per-user and per-IP token-bucket limits; the export endpoint can trigger expensive RPC fan-out.

### M11. `pull_request` workflows pass real secrets via heredoc into `.env`
`.github/workflows/backend-tests.yml:68-71`. `FASTNEAR_API_KEY` and `INTENTS_EXPLORER_API_KEY` are echoed into `.env` during CI. Mainly a concern if a future step prints the file. Either inject via `env:` per-step or use a step-scoped secret.

### M12. `release-plz` workflow uses `secrets: inherit` to the reusable release job
`.github/workflows/release-plz.yml:48`. The reusable workflow now sees every repo secret. Pass only the ones it needs (`NPM_TOKEN`, etc.) explicitly.

### M13. `cut-release.yml` accepts arbitrary `commit_sha` and `bump` inputs from `workflow_dispatch`
`.github/workflows/cut-release.yml:30, 39-45`. Even though `workflow_dispatch` requires write permission, the input flows directly into `actions/checkout` `ref:` and tag generation. Constrain to a branch allowlist (`main`, `release/*`).

### M14. Third-party action `mathieudutour/github-tag-action@v6.2` pinned by tag, not SHA
`.github/workflows/cut-release.yml`. Tag pins are mutable. Repin to a full commit SHA.

### M15. NEAR-API version drift across crates
`nt-be` uses `near-api 0.8.3 / near-primitives 0.34.6`, `bulk-payment` uses `0.7.8 / 0.31.1`, `sandbox-init` uses `0.7.8`, and `nt-cli` uses `0.35.0`. Cross-crate type encoding bugs become possible during shared signing/serialization. Unify on one matched set.

---

## Low Findings

### L1. `intents.near` contract address hardcoded in `bulk-payment` (lib.rs:462)
Make it a `state` field set at `init`.

### L2. Contract has no owner / pause / upgrade authority
No on-chain action available if a future vulnerability is found. Add an `owner_id` and a `paused` flag.

### L3. `nt-be/.env` exists on the developer machine with real signer keys
**Verified:** Yes — file present, **not** tracked in git (`.gitignore` covers `.env`). Risk is local-machine theft / accidental backup. Recommend developers move signer keys to OS keychain / 1Password CLI and remove the local file when not needed.

### L4. `nt-be/.env.test` tracked in git
Contents are public NEAR sandbox genesis keys (known-public). Either rename to `.env.test.example` for clarity, or leave with a top-of-file comment stating "PUBLIC SANDBOX KEYS — DO NOT REUSE OUTSIDE TESTS".

### L5. Hardcoded `postgres:postgres` in `sandbox/start-postgres.sh` + `listen_addresses='*'` + `EXPOSE 5432`
Container-internal only by default, but if `docker run -p 5432:5432` is ever used in a shared environment, the DB is open. Bind to `127.0.0.1` and drop the `EXPOSE`.

### L6. Unauthenticated `/_test/*` endpoints on sandbox port 4000 with `CORS: Any`
`sandbox/sandbox-init/src/mock_server.rs:44-46, 209-430`. Acceptable for in-CI sandbox; would be high if the sandbox is ever exposed publicly for demos.

### L7. `curl … | sh` for cargo-dist and cargo-near installers
`.github/workflows/cli-release.yml:77`, `bulk-payment-test.yml:59`, `sandbox/start-sandbox.sh:10,25`. Acceptable with HTTPS pinning, but checksumming the installer would harden against a single-actor compromise of axodotdev/near releases.

### L8. `npm publish` does not pass `--provenance`
`.github/workflows/cli-release.yml:311-315`. Add `--provenance` (requires npm >=9.5 + OIDC) so consumers can verify the build provenance from the workflow.

### L9. No SBOM / SLSA provenance on Docker images
`.github/workflows/bulk-payment-e2e.yml:72-82`. Pass `provenance: true, sbom: true` to `docker/build-push-action@v6`.

### L10. Sandbox Docker image runs as root
`sandbox/Dockerfile:82`. Add a non-root `USER` for the supervised processes that don't need root.

### L11. Rust toolchain pinned to `stable` (not a specific version) and `oven-sh/setup-bun@v2` with `bun-version: latest`
`.github/workflows/release-plz.yml:27`, `frontend-build.yml`, `frontend-e2e.yml`. Pin to specific Rust and Bun versions for reproducible builds.

---

## Dependency Audit

No Critical-severity unpatched advisories detected in the manifests. All high-risk dependencies are at safe versions (`jsonwebtoken 10.3.0`, `next 16.2.6`, `axios 1.13.2`, `tokio 1.48+`, `sqlx 0.8.6`, `lodash 4.17.21`, `rustls 0.23.35+`, `near-sdk 5.16+`).

| Risk | Detail | Action |
|------|--------|--------|
| Medium | NEAR API version drift across crates (M15) | Unify to `near-api 0.8.3` + `near-primitives 0.35.0` (or current matched set) |
| Medium | `bulk-payment` manifest pins `near-sdk = "5.16"` but `Cargo.lock` resolved 5.18.0 | Tighten manifest to `"5.18"` or regenerate lock with the desired version |
| Medium | `bulk-payment` uses `reqwest 0.11.27` while all others on `0.12.x` | Update to `reqwest 0.12` |
| Low | `nt-fe/near-connect` has no lockfile | Generate one or fold into root workspace |
| Low | Mixed JS package managers (Bun in `nt-fe`, npm in `e2e-tests`) | Standardize |
| Low | OpenSSL system version not asserted | Verify deployment images use OpenSSL 1.1.1+ |

`cargo audit` / `npm audit` were not run during this audit — recommend wiring them into CI as a blocking step.

---

## Remediation Roadmap

### Tier 0 — fix this week, block deploys until done
1. **C1, C2** — add `predecessor_account_id` checks to `ft_on_transfer` and `mt_on_transfer`. Add unit tests that simulate a direct call from a non-token account and expect `panic`.
2. **C3** — convert the three `.detach()` calls in `payout_batch` to `.then(callback)` and only mark `Paid` from the callback.
3. **C4** — fix `sanitizeReturnTo`: reject `//`, `:`, and anything not starting with `/`.
4. **C5** — delete the `println!` at `confidential/mod.rs:137`. Audit the codebase for any other `println!`/`dbg!` lines in handlers.
5. **H1** — add a `refund` path for `Approved`-then-failed lists.
6. **H5** — gate `/api/user/create` behind authentication or a captcha + per-IP funding cap.
7. **H8** — bind auth challenges to the requesting account at issuance.

### Tier 1 — fix this sprint
- **H2** (remove or gate direct `approve_list`), **H3** (cap list size), **H6** (canonical hash encoder), **H7** (nonce store), **H9** (encrypt confidential tokens), **H10** (proxy whitelist), **H11** (validate chart colors).
- **H12** — add `permissions:` blocks to every workflow.
- **H13** — stop baking secrets into the sandbox image; rotate the keys currently published.
- **M8** — ship strict CSP + `X-Frame-Options` headers in `next.config.ts`.
- **M10** — add rate limiting to the heavy endpoints.

### Tier 2 — hardening pass
- **M1–M7, M9, M11–M15** and all Low items.
- Wire `cargo audit` and `npm audit` (or `bun audit`) into CI as blocking.
- Add SLSA provenance / SBOM to npm + Docker publish.
- Pin all third-party actions by SHA.

---

## What was checked but found clean

- **Rust CLI (`nt-cli`)**: Token storage uses atomic tempfile-then-rename to `~/.config/trezu/config.json`; auth flow is NEP-413 signature-based (no private keys handled by the CLI); no `Command::new`/shell-injection paths; HTTPS hardcoded with no env-override. No findings.
- **Goldsky pipelines**: Sinks reference `secret_name: TREZU_RENDER`; no hardcoded creds; SQL transforms use parameterized constructs.
- **Tracked `.env*` files**: Only `.env.example`, `nt-be/.env.example`, and `nt-be/.env.test` are in git. None contain non-public secrets — all values are documented sandbox/example placeholders. (`nt-be/.env` exists locally with real keys but is `.gitignore`'d — see L3.)
- **License risk**: All dependencies are MIT/Apache-2.0/ISC. No GPL/AGPL exposure.
- **Frontend XSS via React rendering**: React auto-escapes by default; the only `dangerouslySetInnerHTML` usages with risk are M7 (theme script) and H11 (chart styles) above.

---

## Methodology Notes

Findings were produced by seven parallel exploration agents (contract, backend, frontend, CI/CD, secrets, CLI+sandbox+goldsky+E2E, dependencies). Every Critical and High finding was then verified directly against the file:line cited (reads or greps shown in the audit transcript). The backend agent originally claimed `nt-be/.env` was committed with production secrets — this was confirmed false against `git ls-files`, and the finding has been demoted to L3 (local-machine risk only).

A few class-level checks deliberately left to a follow-up:
- Full `cargo audit` / `npm audit` runs (tools were not installed in the audit environment).
- Dynamic testing of `payout_batch` against a fork / sandbox (recommended before deploying the C3 fix).
- End-to-end test of the C4 open-redirect exploit on a deployed environment.
