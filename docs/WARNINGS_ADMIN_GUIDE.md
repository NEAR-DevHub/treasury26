# Warnings Admin Panel Guide

The warnings admin panel lets you display status messages, pause features, and manage the waitlist — all without deploying code.

**URL:** `https://<backend>/internal/warnings` (protected by Basic Auth)

**Team access:** set `ADMIN_USERS=alice:secret1,bob:secret2` (password may contain colons). Each login is recorded in the audit log as `changedBy`.

---

## Quick start

1. Open the admin panel and sign in
2. Click **+ Add** to create a new warning
3. Pick a **slot** (where the warning appears)
4. Choose a **scenario** (pre-written message) or write your own
5. Set it to **Active now** or **Schedule for later**
6. Check the **Live preview** at the bottom of the form
7. Hit **Save**

---

## Concepts

### Slots

A slot is _where_ the warning appears in the app. They're grouped into four categories:

| Group             | Slot                         | What it does                                                                |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------- |
| **System**        | App-wide (entire platform)   | Banner in the sidebar — every page sees it                                  |
|                   | Login (all wallets)          | Banner on the login screen; can target a specific wallet                    |
|                   | Treasury creation (waitlist) | Replaces the create-treasury form with a waitlist                           |
| **Features**      | Payments                     | Banner on the payments page                                                 |
|                   | Exchange (Swaps)             | Banner on the exchange page                                                 |
|                   | Deposits                     | Banner on the deposit page                                                  |
| **Actions**       | Creating requests            | Disables every "Create request" button (payments, swaps, members, settings) |
|                   | Voting (Approve / Reject)    | Disables the vote buttons in proposal modals                                |
| **Data displays** | Balances                     | Banner on the dashboard balances section                                    |
|                   | Transaction history          | Banner on the recent transactions section                                   |

### Scenarios

A scenario is a pre-approved message template. When you pick one, the message field fills automatically. You can still edit the text before saving.

**Feature scenarios** (Payments, Exchange, Deposits):

| Scenario                       | What happens                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Swaps/Payments/Deposits paused | Always critical — disables the feature button, shows "Briefly Unavailable", and pauses approval of pending requests of that type |
| Can't process requests         | Same as above — temporary network issue wording                                                                                  |
| Scheduled maintenance          | Always critical — disables the feature button, shows "Briefly Unavailable"                                                       |

> Every feature scenario is **critical**, so the severity picker is hidden when you pick one. To show an informational banner that doesn't block anything, leave the scenario blank and write a custom message with severity set to _warning_.

**App-wide tiers** (escalating severity):

| Tier                          | Severity | Meaning                                             |
| ----------------------------- | -------- | --------------------------------------------------- |
| Tier 1 · Backend issue        | Warning  | Some data may not load, but everything still works  |
| Tier 2 · Transactions paused  | Critical | Users can browse but can't send transactions        |
| Tier 3 · App temporarily down | Critical | The app is down; funds are safe on-chain            |
| Tier 4 · Under investigation  | Critical | Active incident; recommends not making transactions |

### Severity

| Level        | What users see                                           |
| ------------ | -------------------------------------------------------- |
| **Warning**  | Yellow banner with the message — users can still proceed |
| **Critical** | Yellow banner + the relevant button is disabled          |

Some scenarios force the severity automatically (you won't see the severity picker):

- All app-wide tiers
- Scheduled maintenance
- Voting / Creating requests blocked

### Login warnings

Login warnings work differently:

- **All wallets**: Shows a banner above the wallet list on the login screen
- **Specific wallet**: Shows an "Offline" badge on that wallet card with a tooltip message
- Messages are auto-generated — you don't need to write them

If you check **"Also pause login for all wallets"** on an app-wide warning, a login warning is created automatically alongside it.

---

## Message formatting

Messages support a lightweight markdown syntax:

| Syntax                       | Result                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `# Heading` or `### Heading` | Bold heading line (any heading level works)                                                   |
| `[Status page](https://...)` | Clickable link that opens in a new tab                                                        |
| `{action}`                   | Replaced with the page's action word (payment, deposit, swap…)                                |
| `{schedule}`                 | Replaced with the warning's scheduled dates (e.g. "on Jun 25, 3:00 PM until Jun 26, 5:00 PM") |

**Example message:**

```
### Scheduled update
Exchange will be briefly unavailable {schedule}.
```

Renders as:

> **Scheduled update**
> Exchange will be briefly unavailable on Jun 25, 2026 3:00 PM until Jun 26, 2026 5:00 PM.

---

## Scheduling

Warnings can be:

- **Active now** — goes live immediately
- **Scheduled** — set a start and optional end time (in UTC)

Scheduled warnings activate automatically at the start time and are removed from the app at the end time. If no end time is set, the warning stays active until you manually delete it.

When a warning has a schedule, the dates appear in the user-facing message:

- If the message contains `{schedule}`, the dates are inserted inline
- Otherwise, a small "from … until …" line appears below the message

---

## Token / Network scoping

For feature slots (Payments, Exchange, Deposits, Balances, Prices), you can optionally scope a warning to a specific token or network:

- **Token only**: "USDC is slow right now…"
- **Network only**: "Cardano is paused right now…"
- **Both**: "ADA on Cardano is paused right now…"

If you don't select a token or network, the warning applies to the entire feature.

---

## What "critical" actually blocks

| Slot                    | What gets disabled                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Payments                | "Send payment" button shows "Briefly Unavailable", and **approving** pending payment requests is paused |
| Exchange                | "Swap" button shows "Briefly Unavailable", and **approving** pending swap requests is paused            |
| Deposits                | Token and network selectors are disabled                                                                |
| Creating requests       | Every "Create request" button across the app                                                            |
| Voting                  | Approve / Reject buttons in proposal modals                                                             |
| Login (all wallets)     | All wallet buttons are disabled                                                                         |
| Login (specific wallet) | That wallet's button is disabled, shows "Offline" badge                                                 |
| App-wide (Tier 2+)      | All action buttons across the app                                                                       |
| Data displays           | Nothing — these are informational only                                                                  |

> **Rejection is never blocked.** When Payments or Exchange has a critical warning, members can still **reject** pending requests of that type — only approval is paused. In a bulk action, the confirm button is disabled until every selected request can be approved, so unselect the blocked ones to continue. The note shown to the member is the actual warning message you wrote for that slot.

> **Token / network scoping.** If you scope a Payments or Exchange warning to a specific token and/or network, only requests that use that token/network have approval paused — every other request can still be approved normally. Leave token and network as "All" to pause approval for the whole feature.

---

## Incident linking

In the warning form, **Link to upstream service** ties a warning to a live health check so it clears itself when the incident ends:

| Link type | Auto-closes when… |
| --------- | ----------------- |
| **Service only** (e.g. NEAR RPC, NEAR Protocol) | The status monitor sees that service healthy again |
| **Specific NEAR Intents post** | That post disappears from the status API or its scheduled end time passes |

Linked warnings are **deleted automatically** on recovery. The audit log keeps a record (`deleted`, with the slot and link source).

Scheduled warnings with an **end time** are also deleted automatically once that time passes.

**Telegram “Show fallback” warnings count as linked** — activation sets `linked_service` to the failing check (backend, exchange, near-rpc, etc.), so they are removed the same way when that service recovers.

Only **unlinked** warnings (created in admin with no service link) stay until you delete them manually or set a schedule end time.

**Shared slots:** backend, NEAR Protocol, and NEAR RPC all use the app-wide slot. If more than one of those checks is still failing, the app warning is kept until every related incident has recovered.

---

## Tips

- **Always check the live preview** before saving — it shows exactly what users will see
- **Link to an active incident** when you can (NEAR Intents, NEAR Protocol, NEAR RPC) so the warning is removed automatically on recovery; otherwise delete old warnings yourself once the incident is over
- **Use the audit log** tab to see who created/edited/deleted warnings
- **Scenarios keep messaging consistent** — prefer them over custom messages when possible
