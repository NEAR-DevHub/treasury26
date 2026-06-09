# Analytics Events

Most events are fired via `trackEvent()` from `nt-fe/lib/analytics.ts`, which sends to both **PostHog** and **Google Analytics** (GA4) simultaneously.

Some onboarding survey events are provider-specific and are sent directly with `posthog.capture()` (PostHog-only).

Naming is mixed today (`snake_case` and `kebab-case`) due to legacy events. New onboarding events use `snake_case`.

---

## Onboarding & Login (Current)

### `onboarding_wallet_option_clicked`

User clicks a wallet option in the current shared wallet selector.


| Property       | Type    | Description |
| -------------- | ------- | ----------- |
| `wallet_id`    | string  | Wallet key (e.g. `near`, `ledger`) |
| `is_supported` | boolean | Whether wallet is currently supported |
| `source`       | string  | UI surface (e.g. `"/login"`) |
| `connect_flow` | string  | `"onboarding"` or `"within_treasury"` |


**Source:** [nt-fe/components/connect-wallet-selector.tsx](../nt-fe/components/connect-wallet-selector.tsx)

---

### `wallet_connection_completed`

Wallet auth flow successfully completed.


| Property     | Type   | Description |
| ------------ | ------ | ----------- |
| `source`     | string | Current values: `"resolve-auth"` or `"terms-accepted"` |
| `account_id` | string | NEAR account ID when available |


**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts)

---

### `wallet-selected` *(legacy, still emitted)*

Wallet selected in connector callbacks.


| Property      | Type   | Description         |
| ------------- | ------ | ------------------- |
| `wallet_id`   | string | Wallet manifest ID  |
| `wallet_name` | string | Wallet display name |


**Source:** [nt-fe/stores/near-store.ts](../nt-fe/stores/near-store.ts)

---

### `existing_user_treasury_opened`

Login flow identified at least one treasury and navigates to it.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `source`      | string | `"/login"` |
| `treasury_id` | string | Existing treasury ID selected for redirect |


**Source:** [nt-fe/app/(treasury)/login/page.tsx](../nt-fe/app/(treasury)/login/page.tsx)

---

### `survey shown` *(PostHog-only)*

Onboarding survey is shown.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `$survey_id`  | string | PostHog survey ID |


**Source:** [nt-fe/features/onboarding/components/onboarding-questions-step.tsx](../nt-fe/features/onboarding/components/onboarding-questions-step.tsx)

---

### `survey sent` *(PostHog-only)*

Onboarding survey progress/completion payload is sent on Continue/Skip.


| Property                    | Type           | Description |
| --------------------------- | -------------- | ----------- |
| `$survey_id`                | string         | PostHog survey ID |
| `$survey_submission_id`     | string         | Stable submission ID for session flow |
| `$survey_completed`         | boolean        | True when last question is completed |
| `$survey_response_<id>`     | string/string[]| Per-question response |
| `$set`                      | object         | User properties set on completion |


**Source:** [nt-fe/features/onboarding/components/onboarding-questions-step.tsx](../nt-fe/features/onboarding/components/onboarding-questions-step.tsx)

---

## Legacy / Deprecated (Onboarding)

These are retained only for historical references and may still exist in old PostHog data/actions.

- `treasury-creation-step-1-completed`
- `treasury-creation-step-2-completed`
- `treasury-creation-step-3-viewed`
- `new-wallet-connected`
- `onboarding_landing_viewed`
- `onboarding_path_selected`
- `onboarding_cta_clicked`
- `onboarding_step_completed`
- `onboarding-completed`
- `treasury-created`
- `create-treasury-prompt-shown`
- `waitlist-submitted`

## Treasury Settings

### `treasury-settings-updated`

User saves changes to treasury general settings.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/settings/components/general-tab.tsx](../nt-fe/app/(treasury)/[treasuryId]/settings/components/general-tab.tsx)

---

## Members

### `member-add-modal-opened`

User opens the add member modal.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

### `member-add-review-clicked`

User clicks "Review" in the add member flow, triggering validation.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

### `member-add-submitted`

User successfully submits new member(s) for addition.


| Property        | Type   | Description                   |
| --------------- | ------ | ----------------------------- |
| `treasury_id`   | string | Treasury ID                   |
| `members_count` | number | Number of members being added |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

### `member-edit-review-clicked`

User clicks "Review" in the edit member flow.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `treasury_id` | string | Treasury ID |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

### `member-edit-submitted`

User successfully submits member role edits.


| Property        | Type   | Description                    |
| --------------- | ------ | ------------------------------ |
| `treasury_id`   | string | Treasury ID                    |
| `members_count` | number | Number of members being edited |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

### `member-delete-submitted`

User successfully submits member removal.


| Property        | Type   | Description                     |
| --------------- | ------ | ------------------------------- |
| `treasury_id`   | string | Treasury ID                     |
| `members_count` | number | Number of members being removed |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/members/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/members/page.tsx)

---

## Payments

### `payment-submitted`

User submits a single payment request.


| Property       | Type          | Description                        |
| -------------- | ------------- | ---------------------------------- |
| `treasury_id`  | string        | Treasury ID                        |
| `token_symbol` | string        | Token symbol (e.g. `NEAR`, `USDC`) |
| `amount`       | string/number | Payment amount                     |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx)

---

### `bulk-payments-click`

User clicks the bulk payments button on the payments page.


| Property      | Type   | Description       |
| ------------- | ------ | ----------------- |
| `source`      | string | `"payments_page"` |
| `treasury_id` | string | Treasury ID       |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/payments/page.tsx)

---

### `bulk-payments-review-step-view`

User reaches the review step in the bulk payment flow.


| Property           | Type   | Description                                           |
| ------------------ | ------ | ----------------------------------------------------- |
| `source`           | string | `"upload_continue"` | `"edit_save"` | `"edit_cancel"` |
| `treasury_id`      | string | Treasury ID                                           |
| `recipients_count` | number | Number of payment recipients                          |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx)

---

### `bulk-payments-submit-click`

User clicks submit on the bulk payments review step.


| Property      | Type   | Description                   |
| ------------- | ------ | ----------------------------- |
| `source`      | string | `"bulk_payments_review_step"` |
| `treasury_id` | string | Treasury ID                   |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/components/review-payments-step.tsx](../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/components/review-payments-step.tsx)

---

### `bulk-payment-submitted`

Bulk payment batch is successfully submitted on-chain.


| Property           | Type   | Description                       |
| ------------------ | ------ | --------------------------------- |
| `treasury_id`      | string | Treasury ID                       |
| `token_symbol`     | string | Token symbol                      |
| `recipients_count` | number | Number of recipients in the batch |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/payments/bulk-payment/page.tsx)

---

## Exchange (Swap)

### `exchange-submitted`

User submits a token swap proposal.


| Property               | Type   | Description          |
| ---------------------- | ------ | -------------------- |
| `treasury_id`          | string | Treasury ID          |
| `sell_token_symbol`    | string | Token being sold     |
| `receive_token_symbol` | string | Token being received |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/exchange/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/exchange/page.tsx)

---

## Proposals / Requests

### `request-detail-viewed`

User opens a request/proposal detail page.


| Property      | Type   | Description |
| ------------- | ------ | ----------- |
| `proposal_id` | string | Proposal ID |
| `treasury_id` | string | Treasury ID |


**Source:** [nt-fe/app/(treasury)/[treasuryId]/requests/[id]/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/requests/[id]/page.tsx)

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


**Source:** [nt-fe/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal.tsx](../nt-fe/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal.tsx)

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


**Source:** [nt-fe/app/(treasury)/[treasuryId]/dashboard/export/page.tsx](../nt-fe/app/(treasury)/[treasuryId]/dashboard/export/page.tsx)

---


