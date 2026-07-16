# Trezu — Manual Regression Checklist

**Version:** 1.0 · **Date:** 2026-07-08 · **Owner:** QA
**Companion to:** [TEST_STRATEGY.md](TEST_STRATEGY.md) (risk tiers, environments, ownership)

---

## How to use this checklist

**Execution tiers** — every check is tagged with the smallest suite it belongs to:

| Tag | Suite | When | Scope |
|-----|-------|------|-------|
| `S` | **Smoke** (~30–45 min) | After every staging deploy; post-prod-deploy (read-only subset, see §17) | Login, one proposal round-trip, dashboard freshness |
| `R` | **Release regression** (~half day) | Before every production release | All P0/P1 checks + changed P2/P3 areas |
| `F` | **Full regression** (~2 days) | Quarterly, or before high-risk releases (relay/signing/fee changes) | Everything, including wallet matrix and i18n/compat |

**Rules:**

- Checks marked **[auto]** have automated coverage (Playwright/backend integration). During manual regression, verify the CI run is green instead of re-executing by hand — re-test manually only if the automated suite was skipped by path filters (see TEST_STRATEGY §7 cross-component blind spot).
- Risk tier (P0–P3) follows TEST_STRATEGY §1. **Every P0 check is mandatory before release** — no exceptions, no "tested last time".
- Record results per run: pass / fail (+ bug link with severity S1–S4) / blocked / skipped (+ reason). Keep run logs with the release notes.
- Default environment is **staging (Render) with testnet wallets** unless a check says *sandbox* or *prod*. Never use real user funds; DAO for testing is the dedicated staging/QA-owned DAO.

**Test data prerequisites (set up once per run):**

- [ ] QA-owned staging DAO with ≥2 member accounts (proposer + approver), known voting threshold.
- [ ] A second wallet that is **NOT** a member of the DAO (for negative authorization checks).
- [ ] Treasury on **Free plan** with credits near exhaustion (for gating checks) — coordinate with backend to set `monitored_accounts` credits, or burn them down as part of §12.
- [ ] One **confidential** treasury (create in §3 if missing).
- [ ] CSV files: valid bulk-payment CSV (≤25 rows), CSV with 26+ rows, CSV with malformed rows (bad account ID, negative amount, duplicate recipient), address-book import CSV.
- [ ] Wallets installed per matrix in §16: Meteor, Intear, NEAR Mobile, Ledger device, MetaMask (WalletConnect/EVM).

---

## 1. Authentication & Session — P2

| # | Tier | Check | Expected |
|---|------|-------|----------|
| AUTH-01 | S | Login with primary wallet (Meteor) from `/` | Challenge message is human-readable ("Login to Trezu initiated at…"); after signing, user lands authenticated; wallet shown in header |
| AUTH-02 | R | Login from `/login?returnTo=…` deep link | After auth, redirected to the original `returnTo` target, UTM params preserved |
| AUTH-03 | R | First-time terms acceptance | Terms modal blocks the app until accepted; links to Terms of Service and Privacy Policy open; after accept, modal never reappears for this account |
| AUTH-04 | R | Returning-user terms re-acceptance (v1 → v2) | Account that accepted old terms sees the "returning user" variant of the modal |
| AUTH-05 | R | Reject / dismiss terms modal | App remains gated; no authenticated actions possible; store message "connect wallet and accept terms" shown where relevant |
| AUTH-06 | R | Logout | Session cookie cleared; protected pages (address book, settings developer tab) no longer accessible; re-login required |
| AUTH-07 | R | Session expiry / revoked session | With an expired or revoked session, API calls return 401 and UI degrades to logged-out state without crash |
| AUTH-08 | F | Challenge expiry | Start login, wait >15 min before signing, complete signing → login rejected cleanly with a retriable error |
| AUTH-09 | F | Challenge replay | Re-submitting an already-used login payload is rejected (challenge is single-use) |
| AUTH-10 | F | Auth cookie scope | `auth_token` cookie is HttpOnly, Secure, SameSite=Strict (verify in devtools); token not present in localStorage or URLs |
| AUTH-11 | R | Disabled wallets | Passkey and Phantom options are visible but disabled; no dead-end flow when clicked |
| AUTH-12 | F | Wallet "Offline" admin warning | With an active `login.wallet.*` warning slot, the affected wallet shows Offline badge and login via it is discouraged/blocked per design |
| AUTH-13 | F | Ledger login **[auto]** | CI: `ledger-login.spec.ts`. Manual only on real hardware in §16 wallet matrix (WebHID untestable in CI) |

## 2. Compliance: Geo-blocking — P2

Frontend-only enforcement (`nt-fe/proxy.ts`) — VPN or `X-Forwarded-For` header spoofing on staging required.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| GEO-01 | R | Access from a sanctioned country IP (e.g. IR, KP, RU) | Every app route renders the `/blocked` page (rewrite — URL stays the same); no flash of app content |
| GEO-02 | F | Sub-national blocking (Crimea/Sevastopol/Donetsk/Luhansk under UA) | Blocked page shown; rest of UA not blocked |
| GEO-03 | F | Static assets and `/blocked` itself exempt | Blocked page renders fully styled (assets not blocked); no redirect loop |
| GEO-04 | R | Non-sanctioned IP | App loads normally; switching VPN off/on mid-session behaves sanely on next navigation |

## 3. Treasury Creation & Management — P0 (sponsored creation)

| # | Tier | Check | Expected |
|---|------|-------|----------|
| TRS-01 | S | Create **public** treasury (`/create`): name + auto-slugged handle | Progress modal shows steps (creating NEAR → finalizing); ends on new treasury dashboard; DAO exists on-chain as `<handle>.sputnik-dao.near` |
| TRS-02 | R | Handle collision | Taken handle is rejected with inline validation before submission ("check-handle-unused") |
| TRS-03 | R | Create treasury while signed out | "Continue to wallet" gate appears; after login the creation flow resumes with entered values |
| TRS-04 | R | Create **confidential** treasury | Extended progress steps run (registering key → confidential setup → bulk payment provisioning → configuring members → finalizing); treasury opens with confidential banner in sidebar |
| TRS-05 | F | Creation disabled by backend | Waitlist form shown instead of creation; submission acknowledged |
| TRS-06 | F | Interrupted creation (close tab mid-progress) | Creation sweeper job resumes/finishes; treasury eventually usable or clearly failed — no half-created state visible to the user |
| TRS-07 | R | Treasury selector: switch between treasuries, "create new", "manage treasuries" | Correct treasury context everywhere (URL, balances, members) after switching |
| TRS-08 | R | `/app/manage-treasuries`: hide, unhide, remove a saved treasury | List updates immediately; hidden treasuries disappear from selector; state survives re-login |
| TRS-09 | R | Guest flow: open a treasury you're not a member of | Guest badge shown; save/bookmark works; mutating actions (settings developer tab, proposals) hidden or disabled; guest-save tour appears once |
| TRS-10 | F | Start-page states **[auto]** | CI: `start-page.spec.ts` (signed-out form, signed-in redirect, waitlist) |

## 4. Dashboard, Charts & Deposit — P1/P3

| # | Tier | Check | Expected |
|---|------|-------|----------|
| DSH-01 | S | Dashboard loads for the QA DAO | Total balance, assets table, recent activity, and pending requests all populate; no stale-forever spinners |
| DSH-02 | S | Data freshness after an on-chain event | After executing a payment (PAY section), new activity row and balance change appear after refresh indicator completes |
| DSH-03 | R | Chart periods 1W/1M/3M/1Y + token filter **[auto]** | CI: `dashboard-chart-periods.spec.ts`. Manually spot-check only the token-filter dropdown against the assets table |
| DSH-04 | R | Assets table: network breakdown, lockup/vesting detail modals | Amounts per network sum to token total; lockup modal shows vesting schedule |
| DSH-05 | R | Deposit page (`/dashboard/deposit`): asset + network picker | Deposit address matches DAO (public treasury) or intents deposit address (confidential — see CNF-03); QR renders; copy works |
| DSH-06 | F | Onboarding progress widget (3 steps: member → deposit → first payment) | Steps tick off as prerequisites complete; widget disappears when done |
| DSH-07 | F | Onboarding tour **[auto]** | CI: `onboarding-tour.spec.ts` |
| DSH-08 | F | Low-balance warning modal | With DAO NEAR balance below gas threshold, warning modal appears with actionable copy |
| DSH-09 | F | Mobile viewport dashboard **[auto partial]** | CI: `dashboard-chart-mobile.spec.ts` covers chart labels; manually check sidebar/nav collapse on one mobile viewport |
| DSH-10 | F | Public stats page `/stats` | AUM dashboard renders without auth; numbers non-zero and plausible |

## 5. Single Payments — P0

Priority #1 flow per TEST_STRATEGY §4.4 — currently **no E2E coverage**, so manual regression is the only net.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| PAY-01 | S | **Full lifecycle:** create NEAR transfer proposal → relay → vote to approve with second member → execution | Proposal appears in Requests (InProgress → Approved); funds move on-chain; row appears in recent activity with correct amount/recipient; gas credit decremented by exactly the relayed calls |
| PAY-02 | R | FT (NEP-141) transfer to a registered recipient | Correct token, amount and decimals in proposal and after execution |
| PAY-03 | R | FT transfer to a **non-registered** recipient | Storage registration handled (sponsor pays `storage_deposit` on approval); recipient receives tokens |
| PAY-04 | R | Recipient via address book picker | Selecting a saved recipient fills address + network correctly |
| PAY-05 | R | Cross-chain payment (intents/bridge asset, e.g. USDC to another network) | Live quote displays; review step totals match quote; `is_payment` quotes carry **no app fee** (received amount ≈ sent amount minus network costs only) |
| PAY-06 | R | Validation: bad account ID, amount > balance, zero/negative amount, empty recipient | Inline errors; Continue blocked; no proposal created |
| PAY-07 | R | Review step accuracy | Step 2 summary (recipient, amount, token, network, memo) exactly matches step-1 inputs; Back preserves inputs |
| PAY-08 | R | Vote **Reject** path | Proposal moves to Rejected; no funds move; activity shows nothing |
| PAY-09 | F | Quote refresh on intents payment | Stale quote refreshes before submit; amount changes are surfaced, not silently applied |
| PAY-10 | R | Payment receipt page (`/requests/{id}/receipt`) | QR, status, amounts, tx hash correct; printable layout intact; link shareable while unauthenticated (public treasury) |
| PAY-11 | F | Memo/notes round-trip | Memo entered at creation is visible on proposal detail and receipt |

## 6. Relay Authorization Matrix — P0 (negative tests)

API-level checks against staging (`POST /api/relay/delegate-action`), using browser devtools or an HTTP client with the session cookie. These are the money-loss gatekeepers.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| RLY-01 | R | Relay while logged out (no JWT) | 401; nothing relayed |
| RLY-02 | R | Relay a delegate action whose `sender_id` ≠ authenticated user | Rejected; nothing relayed |
| RLY-03 | R | Non-member of the DAO submits `add_proposal` | Rejected by policy check (user lacks AddProposal) |
| RLY-04 | R | Member without vote permission submits `act_proposal` | Rejected per-vote-kind policy check |
| RLY-05 | R | Relay targeting an untracked DAO (not in monitored accounts) | 404 |
| RLY-06 | R | Relay with gas credits exhausted | 402; UI shows "no sponsored transactions" state and Create Request buttons disabled (see PLN-05) |
| RLY-07 | F | Mixed batch (add_proposal + act_proposal in one relay) or non-DAO method call | Rejected — only homogeneous add OR act calls targeting the treasury |
| RLY-08 | F | Oversized attached deposit (standard-tier treasury, deposit > 1 yoctoNEAR) | Rejected (deposit-limit bypass attempt) |
| RLY-09 | R | Successful relay accounting | Exactly one gas credit decremented per successful relayed submit; `paid_near` recorded (verify via `/api/subscription/{account_id}`) |

## 7. Bulk Payments — P0

Priority #2 flow — wizard has **no Playwright coverage** (JS flow scripts cover contract path only).

| # | Tier | Check | Expected |
|---|------|-------|----------|
| BLK-01 | R | **Full lifecycle (native NEAR):** upload valid CSV → review table → submit → DAO approves → payouts complete | Per-recipient statuses progress to paid (payout worker runs every ~5s); recipient balances correct; tx hash per recipient retrievable; batch credit decremented by 1 |
| BLK-02 | R | Paste-mode input | Same parse/validation behavior as CSV upload |
| BLK-03 | R | CSV validation errors | Malformed rows (bad account, negative/zero amount, duplicate recipient) flagged per row; submission blocked until fixed or rows removed |
| BLK-04 | R | Recipient cap (26+ rows) | Rejected with clear limit message (max 25 recipients) |
| BLK-05 | R | Edit a row in review step | Inline edit persists; totals recalculate |
| BLK-06 | R | FT bulk payment incl. a non-registered recipient | Storage handled; all recipients paid |
| BLK-07 | R | DAO **rejects** the list | No payouts; list removed/marked rejected; no batch credit… verify credit handling matches spec (decremented on submit) |
| BLK-08 | F | Duplicate submission of the same list | Second submit rejected or idempotent (list_id hash collision) — no double payout |
| BLK-09 | F | Mid-payout observation | While worker drains a large approved list, status page shows partial progress consistently; refresh-safe |
| BLK-10 | R | Comment/memo on the batch | Visible on proposal and list detail |
| BLK-11 | F | JS E2E flows **[auto partial]** | CI covers native-NEAR only; until `test:all` is gated, manually run FT + non-registered + Intents flows from `e2e-tests/bulk-payment/` per release |

## 8. Exchange / Swap — P0 (fees), P1 (flow)

Priority #3 flow — no E2E coverage.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| EXC-01 | R | **Full lifecycle:** quote (sell NEAR → receive FT) → review → submit proposal → approve → swap settles | Received amount within quoted slippage; activity shows swap (swap detection classifies it, not two unrelated transfers) |
| EXC-02 | R | **Fee integrity (server-side):** inspect `/api/intents/quote` response vs UI | Displayed fee matches server-injected app fee (bps from server env); tampering with fee fields in the client request does **not** change server quote — server ignores client-supplied `appFees`/`referral` |
| EXC-03 | R | Quote expiry countdown on review step | Expired quote cannot be submitted; re-quote flow works |
| EXC-04 | R | Swap direction toggle + amount recalculation | Sell/receive swap keeps amounts consistent with the live dry-run quote |
| EXC-05 | R | Slippage settings modal | Custom slippage persists into the quote; extreme values warned |
| EXC-06 | F | NEAR wrap/unwrap and native-NEAR paths | Both succeed; no app fee on same-asset conversions |
| EXC-07 | F | Market price difference warning | Large deviation from market price is flagged on review |
| EXC-08 | R | Pending exchange proposals button | Lists in-flight swap proposals; navigates to proposal detail |

## 9. Governance: Members, Voting, Requests — P2

| # | Tier | Check | Expected |
|---|------|-------|----------|
| GOV-01 | R | Add member (modal → preview → ChangePolicy proposal → approve) | New member appears with the chosen role after execution; can log in and see member capabilities |
| GOV-02 | R | Edit member roles | Role change proposal round-trips; permission tooltips reflect new role |
| GOV-03 | R | Remove member (with confirmation) | After approval, removed member becomes guest (verify with that wallet) |
| GOV-04 | R | Voting settings: change threshold + vote duration (Settings → Voting) | ChangePolicyUpdateParameters proposal; after execution a new proposal actually requires the new threshold |
| GOV-05 | R | Threshold display consistency | Members page and proposal detail show the same threshold ("x of y") |
| GOV-06 | R | Requests page: tabs (InProgress/Approved/Rejected…), filters, search **[auto partial]** | CI: `requests-page.spec.ts` covers layout; manually verify filter/search results correctness against known proposals |
| GOV-07 | R | Proposal detail + vote modal | Votes recorded per member; state transitions correct; double-vote prevented |
| GOV-08 | F | Proposal expiry | Proposal past vote duration moves to Expired; voting disabled |
| GOV-09 | F | Deep-link into add-member flow (URL param) | Opens the add modal pre-populated |

## 10. Address Book — P3

| # | Tier | Check | Expected |
|---|------|-------|----------|
| ADR-01 | R | Add recipient (name, address, network) | Appears in table; usable from payments picker (PAY-04) |
| ADR-02 | R | Import CSV → review → confirm | Valid rows imported; invalid rows surfaced in review step |
| ADR-03 | R | Export CSV | `address-book.csv` downloads; contents match table |
| ADR-04 | F | Search + multi-select delete | Deleted entries gone after refresh |
| ADR-05 | F | Access control | Address book API requires membership — guest/non-member gets no data (check as non-member wallet) |

## 11. Exports & Activity History — P1

| # | Tier | Check | Expected |
|---|------|-------|----------|
| EXP-01 | R | Export **CSV** with date range + asset + type filters | File downloads; rows match on-screen activity for same filters; amounts, USD values, tx hashes, balance-after correct; no SNAPSHOT/NOT_REGISTERED rows |
| EXP-02 | R | Export **XLSX** and **JSON** | Same data as CSV; XLSX opens in Excel/LibreOffice without warnings; JSON is valid |
| EXP-03 | R | Export credit decrement | New export decrements `export_credits` by 1 (quota bar updates); re-downloading the **same** export from history within 48h is free |
| EXP-04 | R | History-depth limit by plan | Date picker blocks dates older than plan's lookup window; forced API request beyond window returns 403 |
| EXP-05 | R | Export history tab | Past exports listed with working download links; entries expire after ~48h |
| EXP-06 | R | Activity page filters (`/dashboard/activity`) | Sent / received / staking-rewards filters return correct subsets; pagination stable (no dupes/gaps across pages) |
| EXP-07 | F | Staking rewards rows | Rewards appear as `staking:<pool>` entries with plausible epoch amounts |
| EXP-08 | F | Swap rows classified | A completed exchange shows as a swap, not two unrelated transfers |
| EXP-09 | F | API docs playground (`/dashboard/api-docs`) | Query builder produces working requests against the history API |

## 12. Plan & Credit Gating — P2

Run on the Free-plan treasury with credits at/near zero. Verify UI state and server enforcement both.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| PLN-01 | R | Subscription surface sanity | `/api/subscription/{account_id}` values (plan, credits, volume) match what the UI displays |
| PLN-02 | R | Export credits = 0 | Export submit blocked; upgrade prompt shown (trial vs paid copy correct); server rejects a forced request |
| PLN-03 | R | Batch payment credits = 0 | Bulk wizard upload step shows depleted quota + upgrade prompt; submit blocked; server rejects |
| PLN-04 | R | History depth (Free = 3 months) | Activity and export date filters clamp to 3 months; upgrade messaging visible |
| PLN-05 | R | Gas credits = 0 | All "Create Request" buttons disabled with "no sponsored transactions" notice; sidebar sponsored-actions notice appears; relay returns 402 (RLY-06) |
| PLN-06 | F | New treasury launch promo | Freshly created treasury lands on **Plus** plan with Plus credits |
| PLN-07 | F | Monthly reset behavior | After reset job (or simulated month boundary): Plus/Pro credits refill; **Free trial export/batch credits do NOT refill** (gas resets to 10) |
| PLN-08 | F | Exchange fee bps display per plan | Fee shown in exchange expanded view matches plan config (informational — server currently applies global bps, see EXC-02) |

## 13. Confidential Treasuries — P0

| # | Tier | Check | Expected |
|---|------|-------|----------|
| CNF-01 | R | Guest views a confidential treasury | Balances, assets, and activity hidden (ConfidentialState); no data leaks through export, chart, or history APIs (spot-check API responses as non-member) |
| CNF-02 | R | Member views the same treasury | Full balances/history visible after login |
| CNF-03 | R | Deposit shows **intents deposit address**, not raw DAO ID **[auto]** | CI: `confidential-deposit.spec.ts`; manual spot-check on staging once per release |
| CNF-04 | R | Confidential single payment | Shield badge shown; intents-only token list; proposal → approve → recipient paid; amounts never exposed to guests |
| CNF-05 | R | Confidential exchange | Intents-only sell tokens; confidential proposal path completes |
| CNF-06 | F | Confidential bulk payment (prepare → vote → auto-submit → payouts) | Per-recipient intents settle after approval; batch credits checked at prepare; header intent auto-submitted on vote |
| CNF-07 | F | Confidential balance chart / history refresh | Chart renders for members; history-refresh endpoint updates data; guests get nothing |
| CNF-08 | R | Confidential banner | Sidebar banner present, collapsible, explains confidential mode |

## 14. Custom Proposal Templates — P3

| # | Tier | Check | Expected |
|---|------|-------|----------|
| TPL-01 | F | Enable via Settings → Developer, author, pin, fill **[auto]** | CI: `custom-templates.spec.ts` covers authoring validation, code-mode errors, create/pin/fill, access gates |
| TPL-02 | R | Fill + submit one template end-to-end on staging | Proposal created from template args; executes correctly (CI runs on sandbox — staging round-trip is the manual gap) |
| TPL-03 | F | Non-author access | Users without template permission see disabled buttons with tooltips; API rejects direct writes |
| TPL-04 | F | Edit + delete a template | Changes persist; deleted template gone from sidebar pins |

## 15. Settings, Notifications & Misc Product — P3

| # | Tier | Check | Expected |
|---|------|-------|----------|
| SET-01 | R | General: display name, logo upload, primary color | Config proposal round-trips; branding updates after execution |
| SET-02 | F | Preferences: 12/24h time format, timezone (auto + manual) | Timestamps across dashboard/activity/exports respect the setting; persists in localStorage |
| SET-03 | R | Telegram connect (staging flag) → notification delivery | Connect flow via `/telegram/connect` completes; a new proposal / outbound payment / swap fulfillment produces exactly **one** Telegram message (no duplicates); disconnect stops delivery |
| SET-04 | F | Developer tab hidden for guests | Guests cannot enable custom requests |
| SET-05 | F | Earn page | External links (Rhea, Intear DEX, NEAR Staking) open correct targets in new tabs |
| SET-06 | F | Vesting page (`/vesting`, direct URL) | Multi-step lockup proposal wizard completes; schedule visible in asset modal after execution |
| SET-07 | F | Trezu Wallet popup (`/wallet`) **[auto]** | CI: `trezu-wallet.spec.ts` + `trezu-wallet-integration.spec.ts` |
| SET-08 | F | Support center modal | Opens from sidebar; links functional |
| SET-09 | F | Admin warning slots | An active warning (e.g. payments paused) shows the banner and disables the affected action; deleting the warning restores it |

## 16. Compatibility, i18n & Wallet Matrix — F (per release / quarterly)

**Real-wallet matrix** (TEST_STRATEGY §4.5 — mandatory per release, one login + one full proposal round-trip each):

| # | Wallet | Login | Create proposal | Vote/approve | Notes |
|---|--------|-------|-----------------|--------------|-------|
| WAL-01 | Meteor | ☐ | ☐ | ☐ | |
| WAL-02 | Intear | ☐ | ☐ | ☐ | |
| WAL-03 | NEAR Mobile | ☐ | ☐ | ☐ | Test on real device |
| WAL-04 | Ledger (hardware) | ☐ | ☐ | ☐ | WebHID — cannot be automated |
| WAL-05 | EVM via WalletConnect (MetaMask) | ☐ | ☐ | ☐ | |

**i18n / locale:**

| # | Tier | Check | Expected |
|---|------|-------|----------|
| I18N-01 | R | Switch to each production locale (en, es, pt, uk) on money-formatting screens (dashboard, payments, export) | Amounts, decimal separators, and dates format correctly; no missing-key placeholders |
| I18N-02 | F | RTL smoke (he — staging only) | Layout mirrors correctly on dashboard and payments; no clipped controls |
| I18N-03 | F | Locale persistence | `NEXT_LOCALE` cookie honored across sessions; Accept-Language auto-detect works for a first visit |

**Browsers / viewports:**

| # | Tier | Check | Expected |
|---|------|-------|----------|
| CMP-01 | F | Firefox + Safari smoke: login, dashboard, create proposal | No functional breakage (Chromium is the automated baseline) |
| CMP-02 | F | One mobile viewport: login → dashboard → vote on a proposal | Usable end-to-end |

## 17. Admin & Internal — P2

Requires `ADMIN_USERS` credentials; staging only.

| # | Tier | Check | Expected |
|---|------|-------|----------|
| ADM-01 | R | `/internal/api/warnings` + apalis board `/api/v1/*` without credentials | 401 on every route; no data leak |
| ADM-02 | F | Warnings CRUD via admin UI | Create/update/delete reflected on public `/api/warnings` and in the frontend banner (SET-09); audit log records each change |
| ADM-03 | F | Wrong Basic-Auth credentials | 401, no lockout side effects on the app |

## 18. Post-Deploy Production Smoke — run after every prod deploy

Read-only plus **one canary proposal on the QA-owned DAO** (TEST_STRATEGY §6). Never touch user treasuries.

| # | Check | Expected |
|---|-------|----------|
| PRD-01 | `https://trezu.app` loads; `GET /api/health` OK | 200; DB + Goldsky cursor healthy |
| PRD-02 | Login with QA wallet | Auth completes; no terms regression |
| PRD-03 | QA DAO dashboard freshness | Balances and recent activity current (goldsky enrichment + monitoring alive) |
| PRD-04 | Canary proposal: create a minimal transfer proposal on QA DAO via relay, approve, execute | Full P0 round-trip works in prod; gas credit accounting correct |
| PRD-05 | Export a 1-week CSV from QA DAO | File downloads with correct rows |
| PRD-06 | Exchange quote (dry-run only, do not submit) | Quote returns with correct fee bps |
| PRD-07 | Sentry / warnings check | No new S1/S2-class errors in the first 30 min post-deploy |

---

## Coverage traceability (strategy §1 risk tiers → checklist sections)

| Risk tier | Sections | Mandatory before release |
|-----------|----------|--------------------------|
| **P0 — Money loss** | §3 (creation), §5 (payments), §6 (relay matrix), §7 (bulk), §8 EXC-02 (fees), §13 (confidential) | All `S` + `R` checks |
| **P1 — Financial data integrity** | §4 (dashboard freshness), §11 (exports/activity), §8 (swap classification) | All `R` checks |
| **P2 — Access & governance** | §1 (auth), §2 (geo), §6, §9 (governance), §12 (plan gates), §17 (admin) | All `R` checks |
| **P3 — Product experience** | §10, §14, §15, §16 | Changed areas only + exploratory session |

**Known automation gaps this checklist compensates for** (re-check when roadmap items land, then demote to `[auto]`): single payment lifecycle, bulk payment wizard, exchange flow, members/governance, plan/credit gates, confidential payments/exchange, real wallet matrix.

**Maintenance:** update this checklist in the same PR as any feature that adds/changes a user-facing flow; review alongside TEST_STRATEGY.md quarterly.
