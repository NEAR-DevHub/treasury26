# Trezu Incident Messaging Guide

When something in Trezu breaks — a network stalls, a service goes down, a token can't be deposited — use this to pick what to show users, where, and how to post it.

**Status Manager URL:** `https://<backend>/internal/warnings` (Basic Auth)

**Catalog:** [`shared/status-situations.json`](../shared/status-situations.json) — single source of truth for copy, response, severity, and placements.

---

## Three parts work together

| Part                | What it is                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- |
| **In-app messages** | The warning a user sees while using Trezu — what most of this doc is about             |
| **Status page**     | Public log of active incidents; hosted separately so it stays up even if Trezu is down |
| **Status Manager**  | Internal tool to post, edit, and clear a message — any Trezu engineer can use it       |

---

## Classifying an incident

Answer two questions about any incident.

**1. What does the app do? (Response)**

- **Notice** — show a message, but everything still works. The user can act.
- **Paused** — the affected action is turned off. The user can't do it right now.

**2. How much danger are the funds in? (Severity)**

- **Low** — funds safe, nothing unavailable (just slower or cosmetic).
- **High** — funds safe, but something is genuinely unavailable.
- **Critical** — funds may be at risk, or we don't yet know they're safe. This case only: legal writes the message.

The two answers point you to a situation row below.

**Guidelines:**

- Match the message to the situation. A small issue gets a small, quiet message where the problem is; only a whole-app problem gets a site-wide banner.
- Acknowledge the issue, stay calm. Always tell users something's wrong — never pretend everything's fine — but keep the tone plain and factual, never dramatic.
- Keep the cause vague. Say "an issue." Never name a cause we haven't confirmed (not "a breach," not "an RPC failure").
- Be precise about money. When funds are fine, say they're "on-chain and in your control" (a fact). Never say "safe" (a promise).
- If funds might truly be at risk, stop. Say nothing about funds, and bring in product and legal before posting anything.
- Anyone can post Low or High — no sign-off needed. Critical needs product/legal (Ori, US / Vlad, Europe — 24/7 between us).
- Use the standard wording. Each message below is pre-approved. In Status Manager, pick the matching Situation to auto-fill it — only write custom copy for a genuine edge case.

---

## Quick start

1. Open **Trezu Status Manager**
2. Click **+ Add**
3. Pick a **Situation** (row from the table below)
4. Pick **Where it appears** (and scope: token, network, wallet, features…)
5. Review the auto-filled **message**
6. Set **Active now** or **Schedule**
7. **Save**

---

## Situations

| #   | Situation                                                     | Message                                                                                                                                                                                                                                 | Where                                                                  | Response | Severity | Notes                                                                                                                                                        |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Scheduled maintenance** — planned, known ahead              | `### Scheduled update · [what] will be briefly unavailable [schedule].`                                                                                                                                                                 | Affected flow + dashboard note; whole-app also on status page + social | Notice   | Low      | [what]: "Payments" / "Swaps" / "Deposits" / "Some features" / "Trezu" (whole-app adds "Your funds are on-chain and in your control.") See Scheduling ↓       |
| 2   | **Provider maintenance** — upstream scheduled window          | `### Scheduled provider maintenance · [what] may be briefly unavailable [schedule]. Your funds are on-chain and in your control.`                                                                                                       | Affected flow                                                          | Notice   | Low      | Use when downtime is from an upstream provider (e.g. NEAR Intents). Pick affected feature(s) — one warning per page                                          |
| 3   | **Network or token slow** — still works, just slower          | `### [subject] is slow right now · Your [action] will go through once it recovers, it just may take longer than usual.`                                                                                                                 | In the flow, when that token or network is selected                    | Notice   | Low      | [action] = deposit / payment / transaction, to match the flow. Pick token, network, or both — subject composes automatically                                 |
| 4   | **Token or network paused** — one token, one network, or both | Depends on what you pick — see Token / network paused ↓                                                                                                                                                                                 | In the flow, when that token or network is selected                    | Paused   | High     | Covers all three scope variants in one row                                                                                                                   |
| 5   | **Feature pages down** — payments / exchange / deposit        | `### [Feature] is temporarily paused. · We're working on it.`                                                                                                                                                                           | Top of the affected page(s)                                            | Paused   | High     | Select **Several features** and check whichever pages are down — one warning per page. Does not claim other features are working (in case multiple are down) |
| 6   | **Everything halted** — Intents fully down, nothing can move  | `### Transactions are paused right now · A network provider is recovering. Your funds are on-chain and in your control. Updates: [status page]`                                                                                         | Top banner, all pages                                                  | Paused   | High     | Use when all transfers are down, not just one network                                                                                                        |
| 7   | **Balances not showing** — display issue, money untouched     | `### Balance temporarily unavailable. · We can't show your balances right now. Your funds are on-chain and exactly where you left them. You can keep using your treasury.`                                                              | Pop-up once → dashboard balance area + sidebar                         | Notice   | High     | —                                                                                                                                                            |
| 8   | **History not loading** — display issue                       | `### Transaction history isn't loading right now · This affects what you can see, not your funds or your treasury.`                                                                                                                     | Recent Transactions + Requests history                                 | Notice   | High     | —                                                                                                                                                            |
| 9   | **Requests won't process** — can't create or send             | `### Can't process new requests for a few minutes – a temporary network issue. · Your funds are unaffected, try again shortly.`                                                                                                         | Create request buttons + Approve / Reject / Remove                      | Paused   | High     | Creates warnings for create-request buttons and every vote action (approve, reject, remove)                                                                  |
| 10  | **Approvals paused** — pending requests can't be approved     | `Approving requests is paused right now while a network provider recovers. · You can still reject pending requests, and approvals will work again once it's back.`                                                                      | All Approve buttons (vote modal + sidebar)                             | Paused   | High     | Targets the `action.approve` slot only — Reject and Remove keep working. Say so, so approvers aren't stuck                                                    |
| 11  | **Wallet login unavailable** — a wallet provider is down      | All wallets: `### Signing in isn't available right now. Your funds are on-chain and untouched – you can sign in again once it's back.` · One wallet: `### Signing in with [wallet] isn't available right now. ...`                      | Login screen — all wallets banner, or Offline badge on one wallet      | Paused   | High     | No "where" picker — choose All wallets or one wallet. Shows before sign-in, so don't reference a specific treasury                                           |
| 12  | **Backend down** — data won't load                            | `### We're having a temporary issue · Some data may not load. Your funds are on-chain and unaffected – try again shortly.`                                                                                                              | Automatic banner across the app                                        | Notice   | High     | Auto-triggered by health checks — never auto-posted to Telegram                                                                                              |
| 13  | **Whole app down** — Trezu won't load at all                  | `### Trezu is temporarily down. · Your funds are on-chain and in your control. Updates: [status page]`                                                                                                                                  | Status page + social + landing (outside the app)                       | Paused   | High     | Never auto-posted; lives outside the app so it stays visible when Trezu is down                                                                              |
| 14  | **Treasury creation unavailable** — show waitlist             | `Creating new treasuries is invite-only for now. Join the waitlist and we'll let you know when it opens up.`                                                                                                                            | Replaces the create-treasury form                                      | Paused   | Low      | Graceful fallback — welcoming, not apologetic. No funds language (no treasury exists yet)                                                                    |
| 15  | **Funds may be at risk** — STOP                               | No pre-written message — escalate to product + legal. Holding line only: `### We've paused Trezu while we investigate an issue. · We recommend not making any transactions until we confirm everything's clear. Updates: [status page]` | Full-screen block, all pages                                           | Paused   | Critical | Never auto-posted — product + legal write the live message                                                                                                   |

**Recovery:** A message clears when you delete or expire it — there's no "all better" message in the app. The history lives on the status page.

---

## Token / network paused (Row 4)

One situation covers all three scoping variants:

| What you pick in the form | Heading                                    | Body                                               |
| ------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Token only                | "{token} is paused right now"              | "Other tokens work as normal."                     |
| Network only              | "{network} is paused right now"            | "You can use a different network in the meantime." |
| Token **and** network     | "{token} on {network} is paused right now" | "Other tokens work as normal."                     |

---

## Scheduled maintenance

How far ahead to announce depends first on whether it pauses anything, then on how long. A Notice needs little warning; a Paused window needs real lead time, since a treasury team may need to schedule around it.

| Maintenance                 | Announce          | Reminder     |
| --------------------------- | ----------------- | ------------ |
| Notice, any length          | Day-of, in-app    | —            |
| Paused, under ~15 min       | A few hours ahead | —            |
| Paused, 15 min – 1 hr       | 24 hours ahead    | —            |
| Paused, 1 hr+, or whole-app | 48–72 hours ahead | Again day-of |

- Always give an end time, and pad it. Announce a window slightly longer than you expect — back early builds trust, running over destroys it. (Status Manager supports a scheduled end + auto-clear.)
- Pick a low-usage window. Global treasuries mean no truly quiet hour, which is a reason to give more notice. Avoid weekday business hours where you can.
- For long or whole-app windows, post on the status page so users can subscribe — the day-of reminder is what lands.

Use the **Provider maintenance** situation (Row 2) when the downtime is from an upstream provider — it uses different wording ("may be briefly unavailable") that signals the cause is external.

### Relaying a provider maintenance

When a provider we rely on (e.g. NEAR Intents) announces maintenance, the window is theirs — we just relay it promptly.

1. Check it affects our users — does it hit a capability, token, or network they use? If not, internal note only.
2. Select **Provider maintenance** as the situation, pick the affected feature(s), and set their start/end time.
3. Frame it as upstream — "a network provider," never name or blame them.
4. Link it to the incident so it auto-clears when their maintenance ends.

Message: `### Scheduled provider maintenance · [capability] may be briefly unavailable [schedule]. Your funds are on-chain and in your control.`

---

## Special cases

| Situation                         | App behaviour                                              |
| --------------------------------- | ---------------------------------------------------------- |
| **Treasury creation unavailable** | Shows existing waitlist UI (frontend copy unchanged)       |
| **Wallet login unavailable**      | Existing Offline badge / login banner (frontend unchanged) |
| **Funds at risk**                 | Edit message with legal before posting; never auto-posted  |

---

## Telegram ops

Health-check alerts include **Post to app**. Tapping it activates the configured fallback situation. Auto-fallback services:

| Service         | Fallback situation                    |
| --------------- | ------------------------------------- |
| `backend`       | Backend down (row 11)                 |
| `exchange`      | Feature pages down — Exchange (row 4) |
| `near-rpc`      | Transactions halted (row 5)           |
| `near-protocol` | Whole app down (row 12)               |

NEAR Intents has **no** auto-fallback — post manually. Their updates aren't structured enough to classify automatically.
