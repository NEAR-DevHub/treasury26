---
name: trezu-custom-proposal-template
description: Build a custom proposal template for trezu / a SputnikDAO on NEAR — a JSON "manifest" that becomes a reusable form members fill to file a FunctionCall proposal. Use when someone wants a repeatable proposal form (recurring payment, token mint, contract call, set a value) and needs the manifest JSON to paste into trezu. Self-contained; no repo access needed.
---

# Build a trezu custom proposal template

trezu (a SputnikDAO treasury UI on NEAR) lets a DAO turn a recurring on-chain action
into a **reusable form**. The form is defined by a JSON **manifest**. Your job: from a
plain-English description of what the DAO wants to do, produce a valid manifest the user
pastes into trezu (**New template → Code tab → paste → Save**, then optionally tweak in
the Visual tab). Authoring needs the DAO's `ChangePolicy` permission; if the user lacks
it, they hand the manifest to someone who does.

You do **not** need any code or repo — this file is the complete spec.

## How to work with the user

Ask for (and infer sensible defaults where you can):

1. **The on-chain call** — which contract (`receiver_id`) and method (`method_name`)?
   e.g. `guestbook.near` / `set_greeting`, `usdc.near` / `ft_transfer`.
2. **The arguments that method takes**, and for each: **fixed** (same every time) or
   **filled by the member** each time? Member-filled ones become form inputs.
3. **deposit / gas** — yoctoNEAR attached deposit and gas. Default `deposit: "0"`,
   `gas: "30000000000000"` (30 Tgas) if they don't know; a method that needs storage
   often wants `deposit: "1250000000000000000000"` (~0.00125 N).

Then produce the manifest and briefly explain what each member-filled input is.

## The manifest

```json
{
  "version": 1,
  "id": "guestbook-tip",            // slug [A-Za-z0-9_-], unique in the DAO; not create/new/about
  "title": "Guestbook Tip",
  "summary": "Tip {{amount}}",      // optional one-liner; may use {{fields}}
  "binding": {                      // the FIXED on-chain call
    "receiver_id": "guestbook.near",
    "method_name": "add_message",
    "deposit": "1",                       // yoctoNEAR, INTEGER STRING
    "gas": "30000000000000"               // gas, INTEGER STRING
  },
  "fields": [                       // the form inputs members fill
    { "name": "amount", "label": "Amount", "type": "uint", "required": true }
  ],
  "args": { "amount": "{{amount}}" }        // method args; {{name}} -> that field's value
}
```

### Fields

`{ "name", "label", "type", ... }`:

- `name` — `[A-Za-z0-9_]` only (used as a `{{placeholder}}`), unique in the manifest.
- `label` — shown above the input.
- `type` — one of:
  - `account` — a NEAR account id
  - `token` — an omni token id like `base-0x…`
  - `uint` / `amount` — a whole-number string in **base units**, u128-safe
  - `number` — a plain number (for counts/ratios, **not** token amounts)
  - `text` — free text
  - `select` — dropdown (requires `options: ["a","b"]`)
  - `bool` — a toggle
  - `json` — JSON text
- optional: `required` (bool — **not allowed on `bool`**), `default` (must match the
  type), `help` (hint text), `options` (required on `select`, forbidden elsewhere),
  `validation: { min, max, pattern }` (`min`/`max` integer strings, numeric types only;
  `pattern` a regex, `text`/`number` only).

### Args and placeholders

`args` is the literal arguments object. In any string value, `{{name}}` is replaced with
that field's value before filing:

- **Direct**: `"amount": "{{amount}}"`
- **Static (fixed)**: `"app": "trezu"`
- **Composed / concatenated**: `"recipient": "{{first}}.{{last}}"` → `"alice.near"`
- **Field inside a JSON-string argument**:
  `"msg": "{\"receiver_id\":\"{{receiver}}\"}"`

Every `{{placeholder}}` must reference a declared field. `{{{{x}}}}` is an escaped
literal `{{x}}`, not a placeholder.

### Rules (produce manifests that satisfy these)

- `version` is `1`.
- `deposit`, `gas`, `validation.min`/`max`, and `uint`/`amount` values are **integer
  strings in base units — no decimals**. NEAR amounts exceed 2^53, so never use JSON
  numbers. `1.1 NEAR` = `"1100000000000000000000000"` yocto; FT amounts use the token's
  smallest unit (USDC has 6 decimals → micro-USDC).
- Every `{{placeholder}}` (in `args` or `summary`) references a declared field.
- `select` needs `options`; `required` is invalid on `bool`; `default` matches `type`.

## Worked examples

**Simple — set a greeting (one input):**

```json
{
  "version": 1,
  "id": "set-greeting",
  "title": "Set Greeting",
  "binding": { "receiver_id": "guestbook.near", "method_name": "set_greeting",
               "deposit": "0", "gas": "30000000000000" },
  "fields": [ { "name": "greeting", "label": "Greeting", "type": "text", "required": true } ],
  "args": { "greeting": "{{greeting}}" },
  "summary": "Set greeting to {{greeting}}"
}
```

**Composed — a token transfer with a memo (mix of fixed + member inputs):**

```json
{
  "version": 1,
  "id": "usdc-payout",
  "title": "USDC Payout",
  "binding": { "receiver_id": "usdc.near", "method_name": "ft_transfer",
               "deposit": "1", "gas": "30000000000000" },
  "fields": [
    { "name": "recipient", "label": "Recipient", "type": "account", "required": true },
    { "name": "amount", "label": "Amount (micro-USDC)", "type": "amount", "required": true },
    { "name": "note", "label": "Memo", "type": "text" }
  ],
  "args": {
    "receiver_id": "{{recipient}}",
    "amount": "{{amount}}",
    "memo": "Payout: {{note}}"
  },
  "summary": "Pay {{amount}} USDC to {{recipient}}"
}
```

## Deliver it

Give the user the manifest JSON in a code block, name each member-filled input, and tell
them: open trezu → the DAO → **Custom → New template → Code tab**, paste, then **Save**
(switch to the **Visual** tab first if they want to review/edit it as a form). Remind
them authoring needs the DAO's `ChangePolicy` permission.
