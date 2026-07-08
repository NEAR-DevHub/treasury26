# Trezu — Test Strategy

**Version:** 1.0 · **Date:** 2026-07-08 · **Owner:** QA
**Scope:** Trezu platform — `nt-be` (Rust/Axum backend), `nt-fe` (Next.js frontend), `contracts/` (NEAR WASM), `nt-cli`, sandbox and CI.

---

## 1. Product Context & Risk Profile

Trezu is a treasury management platform for NEAR Sputnik DAO multisigs. Users authenticate with NEAR wallets, create and vote on on-chain proposals, execute single and bulk payments, swap tokens cross-chain via NEAR Intents, track historical balances, and export financial reports.

**Why this product demands a risk-based strategy:** it moves real money on an immutable blockchain. A relayed transaction cannot be rolled back, the backend holds hot signing keys (`SIGNER_KEY`, `BULK_PAYMENT_SIGNER`), and financial reports (exports, balance history) are used for accounting and compliance. The cost of a defect is not "a bug ticket" — it is lost funds, a broken audit trail, or a compliance violation.

### Risk tiers

| Tier | Area | Failure impact |
|------|------|----------------|
| **P0 — Money loss** | Relay/meta-transactions (`/api/relay/delegate-action`), bulk payments, treasury/account creation (sponsored), confidential treasuries, exchange quotes & fee enforcement | Irreversible loss of user or sponsor funds |
| **P1 — Financial data integrity** | Balance monitoring & gap-filling, price sync, exports (CSV/JSON/XLSX), swap detection, staking rewards | Wrong accounting data, broken audit trail |
| **P2 — Access & governance** | Auth (NEP-641 challenge/JWT), relay authorization matrix, plan/credit enforcement, admin routes, geo-blocking | Unauthorized actions, compliance breach |
| **P3 — Product experience** | Dashboard/charts, proposal UI, address book, notifications, custom templates, i18n, onboarding | Degraded UX, churn |

Test depth and CI gating strictness scale with tier: P0 areas get the densest automated coverage plus mandatory pre-release manual verification; P3 areas rely mostly on E2E smoke plus exploratory testing.

---

## 2. Quality Goals

1. **No P0 flow ships without automated coverage.** Every code path that signs, relays, or transfers funds has integration tests exercising the real implementation (per the "No Test Simulations" rule in `.github/copilot-instructions.md`).
2. **Deterministic CI.** Tests must not depend on live mainnet — RPC interactions go through the recorded-fixture proxy (`nt-be/tests/fixtures/rpc_cache.tar.zst`) or the sandbox.
3. **Every merged PR is release-candidate quality.** CI gates (fmt, clippy, backend tests, Playwright E2E) are blocking; flaky tests are fixed or quarantined within one sprint, never ignored.
4. **Shift-left via TDD.** The project already mandates writing integration tests first; QA reinforces this in review rather than testing after the fact.

---

## 3. Current State (Baseline, July 2026)

| Layer | What exists | In CI? |
|-------|-------------|--------|
| Backend unit tests | ~359 in-crate tests across ~70 modules in `nt-be/src/` | ✅ `backend-tests.yml` |
| Backend integration | 27 test files / ~84 cases in `nt-be/tests/` (balance collection, staking rewards, notifications, RPC failover, confidential monitoring, …) | ✅ `backend-tests.yml` |
| `bulk-payment` contract | 16 unit + 11 sandbox integration tests | ✅ `bulk-payment-test.yml` |
| `confidential-bulk-payment` contract | 9 unit + 6 integration tests (mock MPC) | ❌ **no workflow** |
| Frontend unit (Bun test) | 9 files / ~115 cases (proposal-template DSL, bulk-payment CSV parsing, config gating) | ❌ **not wired to CI** |
| Playwright E2E | 10 specs / ~67 cases (onboarding tour, wallet flows, custom templates, requests page, charts, confidential deposit) — Chromium only, 1 worker in CI | ✅ `frontend-e2e.yml` |
| Bulk-payment JS E2E | 4 flow scripts in `e2e-tests/bulk-payment/` | ⚠️ only 1 of 4 in CI |
| `nt-cli` | 12 tests | ❌ not in CI |
| Coverage tooling | None | — |
| Performance / load | None | — |

**Strengths:** mature backend integration suite with recorded RPC fixtures; a full local sandbox (NEAR node + backend + Postgres + indexer, `sandbox/`) enabling realistic E2E; strong written testing conventions.
**Weaknesses:** frontend unit tests and two whole components (confidential contract, CLI) are untested in CI; no coverage visibility; E2E skips most money flows (payments, exchange, members, settings); single browser; no non-functional testing.

---

## 4. Test Approach by Layer

The strategy follows the test pyramid: broad and fast at the bottom, few and high-value at the top. Rule of thumb from project conventions: **don't test in the UI what an API test covers, and don't duplicate the same logic at multiple levels** — one end-to-end scenario beats three redundant layer tests.

### 4.1 Unit tests

- **Backend (Rust):** pure logic — fee/credit calculations (`src/config/plans.rs`), price lookup, swap classification, proposal-template manifest validation, JWT handling. Hard assertions only (no `if let Some` guards around test logic).
- **Frontend (TypeScript/Bun):** parsing and business logic extracted from components — template DSL, CSV parsing, form schemas. Target: any function that transforms money amounts, dates, or account IDs has unit tests.
- **Contracts:** state-machine logic in `src/lib.rs` of each contract.

### 4.2 Integration tests (the workhorse layer)

Backend integration tests in `nt-be/tests/` are the primary safety net. Conventions (enforced in review):

- **Use API routes, not raw SQL inserts** — tests must exercise validation and side effects (e.g. register accounts via `POST /api/monitored-accounts`).
- **RPC through the cache proxy** — new tests that hit NEAR RPC require re-recording fixtures with `nt-be/scripts/record-rpc-fixtures.sh`; a `502 Cache miss` in CI means fixtures are stale.
- **`#[sqlx::test]`** for isolated per-test databases.

Priority expansion targets (see roadmap §8): relay authorization matrix, subscription/credit enforcement, export credit decrement, bulk-payment failure paths.

### 4.3 Contract tests (on-chain)

Both WASM contracts run sandbox-based integration tests (`near-sandbox` + `near-api`). Required change: add a CI workflow for `confidential-bulk-payment` mirroring `bulk-payment-test.yml` — it signs opaque payment hashes with MPC and is squarely P0.

### 4.4 End-to-end tests

Two E2E suites, both running against the Docker sandbox (`ghcr.io/near-devhub/trezu/near-treasury-sandbox`):

- **Playwright (`nt-fe/e2e/`)** — UI flows with the mock-wallet helper. Growth priorities, in order:
  1. **Single payment lifecycle:** create transfer proposal → relay → vote → executed → appears in activity and export.
  2. **Bulk payment wizard:** CSV upload → validation errors → submit → per-recipient status.
  3. **Exchange:** quote → proposal creation → fee display matches server config.
  4. **Members/governance:** role change proposal, threshold display.
  5. **Plan gates:** export blocked when credits exhausted; history depth limits.
- **Bulk-payment JS flows (`e2e-tests/bulk-payment/`)** — promote `test:all` (FT, non-registered recipients, Intents) into CI; today only the native-NEAR flow is gated.

E2E discipline: `data-testid` selectors, web-first assertions (`expect(locator).toBeVisible()`), no arbitrary waits, independent and idempotent tests (the global setup pre-creates DAOs; tests must not share mutable treasury state). Trace-on-retry is already configured — failures are debugged from traces, not by re-running locally.

### 4.5 Manual & exploratory testing

Automation cannot cover everything here. Session-based exploratory testing (time-boxed charters) is mandatory for:

- **Real wallet matrix** (per release): Meteor, Intear, NEAR Mobile, Ledger (hardware — WebHID signing is untestable in CI, documented in `nt-fe/e2e/README.md`), EVM via WalletConnect.
- **Testnet/mainnet smoke** after deploy: login, create a proposal on a staging DAO, verify relay, check dashboard data freshness.
- **New features** before their automation lands, guided by risk tier.
- **Geo-blocking and terms acceptance** (compliance paths that are awkward to automate end-to-end).

Charter results are logged as lightweight session notes; bugs filed with reproduction steps and the risk tier attached.

---

## 5. What We Explicitly Do NOT Test

- **Third-party internals:** NEAR RPC correctness, DeFiLlama price accuracy, 1click quote pricing, Telegram delivery guarantees. We test *our handling* of their failures (timeouts, malformed responses, RPC failover — already covered by `rpc_failover_test.rs`), not the services themselves.
- **Sputnik DAO factory contract logic** — audited upstream; we test our integration with it.
- **Pixel-perfect rendering across all browsers** — until visual regression tooling is justified, Chromium E2E + manual spot checks suffice.

---

## 6. Environments & Test Data

| Environment | Purpose | Data |
|-------------|---------|------|
| **Local sandbox** (`sandbox/`, ports 3030/8080/5001/5432) | Dev + E2E; full NEAR node with pre-deployed contracts | Ephemeral; DAOs created per run via API |
| **Test Postgres** (`nt-be/docker-compose.yml`, port 5433) | Backend integration tests | Per-test isolated DBs via `#[sqlx::test]`; SQL seed fixtures in `tests/test_data/` |
| **RPC fixture cache** | Deterministic mainnet-data replay in CI | Recorded archive, versioned in-repo; re-record when tests add RPC calls |
| **Staging (Render)** | Pre-prod manual verification, real testnet wallets | Dedicated staging DAOs; never real user funds |
| **Production** (`trezu.app` / `api.trezu.app`) | Post-deploy smoke only | Read-only checks + one canary proposal on a QA-owned DAO |

**Test data rules:** no production data in tests; snapshots regenerated only deliberately (`GENERATE_NEW_TEST_SNAPSHOTS=1`) with the diff reviewed like code; wallet keys used in E2E are sandbox-only throwaways.

---

## 7. CI/CD Quality Gates

Current gates stay blocking; the table below is the target state (△ = to add).

| Gate | Workflow | Status |
|------|----------|--------|
| Rust fmt + clippy (`-D warnings`) | `backend-tests.yml` | ✅ |
| Backend unit + integration tests | `backend-tests.yml` | ✅ |
| Frontend build, Biome format, i18n check | `frontend-build.yml` | ✅ |
| **Frontend unit tests (`bun test`)** | `frontend-build.yml` | △ add `test` script + CI step |
| Playwright E2E (sandbox) | `frontend-e2e.yml` | ✅ |
| `bulk-payment` contract tests | `bulk-payment-test.yml` | ✅ |
| **`confidential-bulk-payment` contract tests** | new workflow | △ |
| **`nt-cli` tests** | new or extended workflow | △ |
| **All 4 bulk-payment E2E flows** | `bulk-payment-e2e.yml` | △ switch `npm test` → `test:all` |
| **Coverage reporting** (`cargo llvm-cov` + `bun test --coverage`) | both test workflows | △ report-only first; thresholds on P0 modules later |

**Cross-component blind spot to fix:** path filters mean backend changes don't trigger frontend E2E and vice versa. Add a nightly full-suite run (all workflows, `test:all`, both contracts) so integration regressions surface within 24h even when path filters skip them on PRs.

**Flaky test policy:** a test that fails then passes on retry is logged; two flakes in a week → owner assigned, fixed or quarantined (skipped with a linked issue) within the sprint. CI retries (Playwright `retries: 2`) are a detection mechanism, not a fix.

---

## 8. Non-Functional Testing

- **Security (highest NFR priority).** Quarterly focused reviews plus per-feature checks on: relay authorization matrix (non-member, wrong DAO, exhausted credits, restricted proposal types), auth challenge replay/expiry, admin Basic-Auth routes, JWT cookie scope, deposit-limit bypass attempts, fee-tampering on exchange quotes (server must ignore client-supplied fees — `nt-be/src/handlers/intents/quote.rs`). Secrets never leave the backend; any PR touching `SIGNER_KEY`/`BULK_PAYMENT_SIGNER` code paths gets mandatory QA + security review.
- **Performance.** Start with k6 smoke profiles against the sandbox for the two hot read paths (`GET /api/balance-changes`, `GET /api/proposals/{dao_id}`) and the relay endpoint; establish baselines before setting SLOs. Background-job throughput (goldsky enrichment, bulk-payment payout at 5s intervals) is monitored in production via existing Sentry/warnings rather than load-tested initially.
- **Compatibility.** Add Firefox and WebKit Playwright projects for a smoke-tagged subset (login, dashboard, create proposal); full suite stays Chromium. Mobile viewports already partially covered (`dashboard-chart-mobile.spec.ts`) — extend the smoke set to one mobile viewport.
- **i18n.** Build-time parity check exists; add one locale-switching E2E verifying non-default locale renders on money-formatting screens (amounts, dates are the risk).
- **Accessibility.** Lightweight: `@axe-core/playwright` scan on the five main pages, report-only initially.

---

## 9. Defect Management & Metrics

**Workflow:** bugs are filed with risk tier, environment, and reproduction steps; merged PRs auto-move linked issues to "QA In Progress" (`move-linked-issues-to-qa.yml`) where QA verifies on staging before closing.

**Severity ↔ response:**

| Severity | Definition | Response |
|----------|-----------|----------|
| S1 | Funds at risk, relay/signing broken, data corruption | Hotfix immediately; incident review |
| S2 | P0/P1 feature broken, no workaround | Fix before next release |
| S3 | Feature degraded, workaround exists | Prioritized in backlog |
| S4 | Cosmetic, minor UX | Backlog |

**Metrics reviewed monthly (kept minimal and actionable):**

1. Escaped defects by tier (bugs found in prod vs. staging/CI) — the north-star quality metric.
2. CI stability: flake rate and mean pipeline duration.
3. Coverage trend on P0 modules (once tooling lands) — trend matters, not an absolute target.
4. E2E coverage of the P0 flow list (§4.4) — a simple checklist, reviewed per release.

---

## 10. Roadmap

### Quick wins (1–2 weeks)
1. Add `"test": "bun test"` to `nt-fe/package.json` and a step in `frontend-build.yml` — ~115 existing tests start gating PRs at near-zero cost.
2. New workflow for `confidential-bulk-payment` contract tests (copy `bulk-payment-test.yml`).
3. Switch `bulk-payment-e2e.yml` to `npm run test:all`.
4. Add `nt-cli` tests to CI.

### Medium term (1–2 months)
5. Playwright specs for the top-3 missing P0/P1 flows: single payment lifecycle, bulk-payment wizard, plan/credit gates.
6. Backend integration tests for the relay authorization matrix and subscription credit enforcement.
7. Coverage reporting (`cargo llvm-cov`, `bun test --coverage`) wired into CI, report-only.
8. Nightly full-suite workflow (cross-component regression net).

### Long term (3–6 months)
9. k6 performance baselines and SLOs for hot endpoints.
10. Firefox/WebKit + mobile smoke projects; axe accessibility scans.
11. Exchange/Intents E2E against sandbox with mocked 1click responses.
12. Coverage thresholds on P0 backend modules; quarterly security-focused test review cadence.

---

## 11. Ownership

- **Developers** own unit + integration tests for their changes (TDD is the mandated workflow) and fixing their flaky tests.
- **QA** owns the E2E suites, exploratory charters, the release smoke checklist, this strategy document, and CI quality-gate configuration.
- **QA + security reviewer** jointly sign off changes touching signing keys, relay authorization, or fee calculation.

**Review cadence:** this document is revisited quarterly or when a major component ships (e.g., live billing via Stripe/PingPay, which is currently deferred — see `docs/AI_SUBSCRIPTION_GUIDE.md`).
