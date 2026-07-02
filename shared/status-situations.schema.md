# status-situations.json

One row per playbook situation. Keep it readable — extra rules live in admin UI code, not here.

## Top level

| Field | Purpose |
| ----- | ------- |
| `statusPageLink` | Markdown link substituted for `{statusPageLink}` |
| `placements` | Internal code → admin label for "Where it appears" |
| `situations` | The catalog |

## Each situation

| Field | Required | Purpose |
| ----- | -------- | ------- |
| `id` | yes | Stored in DB |
| `row` | no | Playbook row number |
| `label` | yes | What admin picks in step 1 |
| `response` | yes | `notice` or `paused` |
| `severity` | yes | `low`, `high`, or `critical` |
| `where` | yes | Playbook placement description |
| `placements` | yes | Valid "where" codes (pick one mode). Use `features` for Payments/Exchange/Deposits multi-select — do not also list `payments`, `exchange`, or `deposit` on the same situation. |
| `scope` | no | Extra inputs admin must fill — see below |
| `message` | no* | Default copy. `### line` = heading, rest = body |
| `byPlacement` | no | Copy overrides when placement changes the wording |
| `customCopy` | no | If true, admin must edit before post (row 15) |
| `noAutoPost` | no | If true, Telegram never auto-posts this |

\*Use `message` or `byPlacement` (or both — `byPlacement` wins when present).

## Scope values

| Value | Admin fills |
| ----- | ----------- |
| `token+network` | Both token and network (one chain) |
| `token` | Token only (all networks) |
| `token\|network` | At least one of token or network (slow notice). If both are set, `{subject}` = \"Token on Network\" |
| `network` | Network only (all tokens on that chain) |
| `wallet` | Wallet name (single-wallet login) |
| `schedule` | From scheduling fields → `{schedule}` |
| `schedule+capability` | Schedule + which feature (Swaps / Deposits / …) |
| `requestType` | `payments` or `swaps` |

## Placeholders in messages

| Placeholder | Filled from |
| ----------- | ----------- |
| `{subject}` | Token, network, or \"Token on Network\" when both scope fields are filled |
| `{token}`, `{network}`, `{wallet}` | Scope fields |
| `{action}` | Flow (payment / deposit / …) |
| `{schedule}` | Event start/end |
| `{requestType}`, `{capability}` | Admin input |
| `{statusPageLink}` | Top-level link |

## Stored in DB

Saved as `user_message`: same string as `message` / `byPlacement` after placeholders are filled.
