# Analytics Events

Most events are fired via `trackEvent()` from `nt-fe/lib/analytics.ts`, which sends to both **PostHog** and **Google Analytics** (GA4) simultaneously.

Some onboarding survey events are provider-specific and are sent directly with `posthog.capture()` (PostHog-only).

Naming is mixed today (`snake_case` and `kebab-case`) due to legacy events. New onboarding events use `snake_case`.

---

## Onboarding Funnel (PostHog)

Recommended sequential funnel for new-user onboarding:

1. `onboarding_landed`
2. `onboarding_login_completed` _(optional — users already logged in may skip this step)_
3. `treasury-created`

Track returning users separately with `onboarding_existing_treasury_redirect` (not part of the funnel).

Break down step 1 by `page` (`"/"` vs `"/create"`).

`/login` is in-app login, not onboarding — it fires `wallet_connection_completed` only.

---

## Onboarding & Login

### `onboarding_landed`

User enters the onboarding flow on `/` or `/create`. Not fired when a logged-in user with an existing treasury is auto-redirected to their dashboard.

| Property           | Type    | Description                                      |
| ------------------ | ------- | ------------------------------------------------ |
| `page`             | string  | `"/"` or `"/create"`                             |
| `is_authenticated` | boolean | Whether user already had a session at entry time |

**Source:** [nt-fe/features/onboarding/components/create-treasury-entry.tsx](../nt-fe/features/onboarding/components/create-treasury-entry.tsx)

---

### `onboarding_existing_treasury_redirect`

Logged-in user with at least one treasury landed on `/` or `/create` and is redirected to their treasury (not a new onboarding start).

| Property      | Type   | Description               |
| ------------- | ------ | ------------------------- |
| `entry_page`  | string | `"/"` or `"/create"`      |
| `treasury_id` | string | Treasury ID redirected to |

**Source:** [nt-fe/features/onboarding/components/create-treasury-entry.tsx](../nt-fe/features/onboarding/components/create-treasury-entry.tsx)

---

### `onboarding_login_completed`

User completed wallet login during onboarding (`/` or `/create`). Not fired for `/login` or other in-app login surfaces.

| Property     | Type   | Description          |
| ------------ | ------ | -------------------- |
| `page`       | string | `"/"` or `"/create"` |
| `account_id` | string | NEAR account ID      |

**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts) — only when `connect()` is called with an `onboardingPage` argument from [create-treasury-entry.tsx](../nt-fe/features/onboarding/components/create-treasury-entry.tsx)

---

### `onboarding_wallet_option_clicked`

User clicks a wallet option in the shared wallet selector. Does **not** fire when the user clicks the NEAR wallet group card (opens sub-picker only); fires when a specific wallet is chosen.

| Property       | Type    | Description                                      |
| -------------- | ------- | ------------------------------------------------ |
| `wallet_id`    | string  | Wallet key (e.g. `ledger`, `meteor-wallet`)      |
| `is_supported` | boolean | Whether wallet is currently supported            |
| `source`       | string  | UI surface (e.g. `"/"`, `"/create"`, `"/login"`) |
| `connect_flow` | string  | `"onboarding"` or `"within_treasury"`            |

**Source:** [nt-fe/components/connect-wallet-selector.tsx](../nt-fe/components/connect-wallet-selector.tsx)

---

### `wallet-selected`

Wallet selected in the connector during login.

| Property      | Type   | Description         |
| ------------- | ------ | ------------------- |
| `wallet_id`   | string | Wallet manifest ID  |
| `wallet_name` | string | Wallet display name |

**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts)

---

### `wallet_connection_completed`

Wallet auth flow successfully completed. Fired for all login surfaces (onboarding, `/login`, etc.).

| Property     | Type   | Description                            |
| ------------ | ------ | -------------------------------------- |
| `source`     | string | `"resolve-auth"` or `"terms-accepted"` |
| `account_id` | string | NEAR account ID when available         |

**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts)

---

### `treasury-created`

Treasury creation stream completed successfully.

| Property      | Type   | Description     |
| ------------- | ------ | --------------- |
| `treasury_id` | string | New treasury ID |

**Source:** [nt-fe/features/onboarding/components/create-treasury-entry.tsx](../nt-fe/features/onboarding/components/create-treasury-entry.tsx)

---

### `onboarding-completed`

Fired alongside `treasury-created` when a new treasury is created.

| Property      | Type   | Description     |
| ------------- | ------ | --------------- |
| `treasury_id` | string | New treasury ID |

**Source:** [nt-fe/features/onboarding/components/create-treasury-entry.tsx](../nt-fe/features/onboarding/components/create-treasury-entry.tsx)

---

## Legacy / Deprecated (Onboarding)

These may still exist in old PostHog data but are no longer emitted:

- `treasury-creation-step-1-completed`
- `treasury-creation-step-2-completed`
- `treasury-creation-step-3-viewed`
- `new-wallet-connected`
- `onboarding_landing_viewed`
- `onboarding_path_selected`
- `onboarding_cta_clicked`
- `onboarding_step_completed`
- `create-treasury-prompt-shown`
- `waitlist-submitted`
- `existing_user_treasury_opened`
- `survey shown` _(PostHog-only)_
- `survey sent` _(PostHog-only)_

---

## Treasury Settings

### `treasury-settings-updated`

User saves changes to treasury general settings.

| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/settings/components/general-tab.tsx](<../nt-fe/app/(treasury)/[treasuryId]/settings/components/general-tab.tsx>)

---

## Members

### `member-add-modal-opened`

User opens the add member modal.

| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

### `member-add-review-clicked`

User clicks "Review" in the add member flow, triggering validation.

| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

### `member-add-submitted`

User successfully submits new member(s) for addition.

| Property        | Type   | Description                   |
| --------------- | ------ | ----------------------------- |
| `treasury_id`   | string | Treasury ID                   |
| `members_count` | number | Number of members being added |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

### `member-edit-review-clicked`

User clicks "Review" in the edit member flow.

| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

### `member-edit-submitted`

User successfully submits member role edits.

| Property        | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `treasury_id`   | string | Treasury ID                    |
| `members_count` | number | Number of members being edited |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

### `member-delete-submitted`

User successfully submits member removal.

| Property        | Type   | Description                     |
| --------------- | ------ | ------------------------------- |
| `treasury_id`   | string | Treasury ID                     |
| `members_count` | number | Number of members being removed |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx>)

---

## Payments

### `payment-submitted`

User submits a single payment request.

| Property       | Type          | Description                        |
| -------------- | ------------- | ---------------------------------- |
| `treasury_id`  | string        | Treasury ID                        |
| `token_symbol` | string        | Token symbol (e.g. `NEAR`, `USDC`) |
| `amount`       | string/number | Payment amount                     |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx>)

---

### `bulk-payments-click`

User clicks the bulk payments button on the payments page.

| Property      | Type   | Description       |
| ------------- | ------ | ----------------- |
| `source`      | string | `"payments_page"` |
| `treasury_id` | string | Treasury ID       |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx>)

---

### `bulk-payments-review-step-view`

User reaches the review step in the bulk payment flow.

| Property           | Type   | Description                  |
| ------------------ | ------ | ---------------------------- | ------------- | --------------- |
| `source`           | string | `"upload_continue"`          | `"edit_save"` | `"edit_cancel"` |
| `treasury_id`      | string | Treasury ID                  |
| `recipients_count` | number | Number of payment recipients |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx>)

---

### `bulk-payments-submit-click`

User clicks submit on the bulk payments review step.

| Property      | Type   | Description                   |
| ------------- | ------ | ----------------------------- |
| `source`      | string | `"bulk_payments_review_step"` |
| `treasury_id` | string | Treasury ID                   |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/components/review-payments-step.tsx](<../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/components/review-payments-step.tsx>)

---

### `bulk-payment-submitted`

Bulk payment batch is successfully submitted on-chain.

| Property           | Type   | Description                       |
| ------------------ | ------ | --------------------------------- |
| `treasury_id`      | string | Treasury ID                       |
| `token_symbol`     | string | Token symbol                      |
| `recipients_count` | number | Number of recipients in the batch |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx>)

---

## Exchange (Swap)

### `exchange-submitted`

User submits a token swap proposal.

| Property               | Type   | Description          |
| ---------------------- | ------ | -------------------- |
| `treasury_id`          | string | Treasury ID          |
| `sell_token_symbol`    | string | Token being sold     |
| `receive_token_symbol` | string | Token being received |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/exchange/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/exchange/page.tsx>)

---

## Proposals / Requests

### `request-detail-viewed`

User opens a request/proposal detail page.

| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `proposal_id` | string | Proposal ID |
| `treasury_id` | string | Treasury ID |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/requests/[id]/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/requests/[id]/page.tsx>)

---

### `proposal-voted`

User submits a vote on one or more proposals.

| Property          | Type   | Description                               |
| ----------------- | ------ | ----------------------------------------- |
| `vote`            | string | Vote value (e.g. `"approve"`, `"reject"`) |
| `proposals_count` | number | Number of proposals voted on              |
| `treasury_id`     | string | Treasury ID                               |

**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts)

---

## Deposit

### `deposit-asset-and-network-selected`

User selects both an asset and a network in the deposit modal.

| Property       | Type   | Description                   |
| -------------- | ------ | ----------------------------- |
| `treasury_id`  | string | Treasury ID                   |
| `asset_id`     | string | Selected asset ID             |
| `asset_name`   | string | Selected asset display name   |
| `network_id`   | string | Selected network ID           |
| `network_name` | string | Selected network display name |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal.tsx](<../nt-fe/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal.tsx>)

---

## Export

### `export-click`

User clicks the export button (CSV/report download shortcut).

| Property      | Type   | Description       |
| ------------- | ------ | ----------------- |
| `source`      | string | `"export_button"` |
| `treasury_id` | string | Treasury ID       |

**Source:** [nt-fe/components/export-button.tsx](../nt-fe/components/export-button.tsx)

---

### `export-generate-click`

User clicks "Generate" on the full export page.

| Property        | Type   | Description                     |
| --------------- | ------ | ------------------------------- |
| `source`        | string | `"dashboard_export_page"`       |
| `treasury_id`   | string | Treasury ID                     |
| `document_type` | string | Type of document being exported |

**Source:** [nt-fe/app/(treasury)/[treasuryId]/dashboard/export/page.tsx](<../nt-fe/app/(treasury)/[treasuryId]/dashboard/export/page.tsx>)

---
