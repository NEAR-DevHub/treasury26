# Custom proposal templates

trezu creates the everyday treasury proposals — payments, transfers, staking — natively,
but a SputnikDAO can call **any method on any contract**. trezu could already *display*
those proposals; it just had no way to *create* them. **Custom proposal templates** close
that gap: a DAO authors a reusable form once, and members fill it to file an arbitrary
SputnikDAO **`FunctionCall`** proposal — no hand-written base64 args, no developer needed.

The form definition is a JSON **manifest** (the DSL described below). The proposal a
template produces still passes the DAO's normal permissions and approvals, so a manifest
never grants authority by itself.

This doc is the canonical reference for the manifest DSL, the architecture, and the
authoring UI. The in-app `/<dao>/custom-templates/about` page derives from it.

## What it produces

Filling a template builds one SputnikDAO `FunctionCall` proposal:

```
receiver_id: <binding.receiver_id>
actions: [ FunctionCall {
  method_name: <binding.method_name>,
  args:        <args with every {{placeholder}} substituted, base64-encoded>,
  deposit:     <binding.deposit>,   // yoctoNEAR
  gas:         <binding.gas>,
} ]
description: "<title>\n\n[trezu-tmpl:<id>]"   // the tag is the provenance marker
```

Member-supplied values flow only into `args` (and the human-readable `summary`); the
contract, method, deposit, and gas are fixed by the template author.

## The manifest DSL

A manifest is a JSON object. `version` is `1` (the only shape this schema describes).

| Key | Required | Notes |
|-----|----------|-------|
| `version` | yes | literal `1` |
| `id` | yes | tag-safe slug `[A-Za-z0-9_-]`, unique per DAO. The page URL (`/custom-templates/<id>`) **and** the `[trezu-tmpl:<id>]` description tag. Reserved: `create`, `new`, `about`. |
| `title` | yes | non-blank |
| `description` | no | non-blank if present |
| `icon` | no | non-blank if present |
| `summary` | no | human one-liner shown while filing; may use `{{placeholders}}` |
| `binding` | yes | the fixed on-chain call (below) |
| `fields` | yes | array of form inputs (below) |
| `args` | yes | the call arguments — a JSON object; string values may embed `{{placeholders}}` |

### `binding` — the on-chain call

```json
"binding": {
  "receiver_id": "guestbook.near",     // the contract
  "method_name": "add_message",        // the method
  "deposit": "1",                      // yoctoNEAR, integer string (u128-safe)
  "gas": "30000000000000"              // gas, integer string
}
```

`deposit`/`gas` are **integer strings** in base units — there are no decimals at the
contract boundary (1.1 NEAR = `1100000000000000000000000` yocto). They exceed 2^53, so
they must be strings, never JSON numbers.

### `fields` — the form inputs

Each field is `{ name, label, type, ... }`:

| Field key | Notes |
|-----------|-------|
| `name` | `[A-Za-z0-9_]` — must be `{{placeholder}}`-safe; unique within the manifest |
| `label` | non-blank; shown above the input |
| `type` | one of the types below |
| `required` | optional bool; **not allowed on `bool`** (a toggle always submits) |
| `default` | optional; must match `type` (string for text-ish, number for `number`, boolean for `bool`, an option for `select`, any JSON for `json`) |
| `help` | optional; shown under the input |
| `options` | required for `select`, forbidden otherwise; array of strings |
| `validation` | optional `{ min, max, pattern }` (below) |

Types:

| `type` | Renders / validates as |
|--------|------------------------|
| `account` | a NEAR account id (validated shape) |
| `token` | an omni token id, e.g. `base-0x…` (free text) |
| `uint` | a whole-number string, u128-safe |
| `amount` | a whole-number string, u128-safe (base units — no decimals) |
| `number` | a numeric value (JS number / f64 — for counts/ratios, **not** amounts) |
| `text` | free text |
| `select` | dropdown of `options` |
| `bool` | a toggle |
| `json` | JSON text |

`validation`:
- `min` / `max` — integer strings; only on numeric types (`uint`/`amount`/`number`).
- `pattern` — a regular expression; only on `text` / `number`. Must compile.

> u128 safety: `deposit`/`gas`/`validation.min`/`max` and `uint`/`amount` field values
> stay digit strings end-to-end, never JS numbers, so NEAR amounts (which exceed 2^53)
> survive untruncated.

### `args` — the call arguments

`args` is a JSON object — the literal method arguments. Each string value may contain
`{{name}}` placeholders that reference a declared field by `name`. At fill time the
engine substitutes each placeholder with the member's value:

```json
"args": {
  "app":    "trezu",                        // static
  "text":   "{{message}}",                  // direct member value
  "amount": "{{tip}}",                      // direct member value (u128)
  "meta":   "{\"by\":\"{{author}}\"}"       // composed: a field inside a string
}
```

A value need not be a string. `args` may hold any JSON — numbers, booleans, `null`,
nested objects, arrays (the visual builder offers these as static value types). Non-string
values are sent to the contract **verbatim**; `{{placeholders}}` are only ever resolved
inside string values, so a number/bool/object passes through exactly as written.

Rules:
- **Every `{{placeholder}}` must reference a declared field.** A dangling reference is
  a validation error (attributed to `args` or `summary`).
- An escaped `{{{{literal}}}}` collapses to a literal `{{literal}}` and is never treated
  as a placeholder.
- Concatenation / composition is just multiple placeholders in one string
  (`"{{first}}.{{last}}"` → `"alice.near"`).
- Amounts stay digit strings, so u128 values never lose precision.

### A minimal example

```json
{
  "version": 1,
  "id": "set-greeting",
  "title": "Set Greeting",
  "binding": {
    "receiver_id": "guestbook.near",
    "method_name": "set_greeting",
    "deposit": "0",
    "gas": "30000000000000"
  },
  "fields": [
    { "name": "greeting", "label": "Greeting", "type": "text", "required": true }
  ],
  "args": { "greeting": "{{greeting}}" },
  "summary": "Set greeting to {{greeting}}"
}
```

## Authoring (the UI)

`/<dao>/custom-templates/create` (and `…/<slug>/edit`) offer **Visual** and **Code**
modes over the same manifest; both validate through the one `parseManifest`.

### Visual mode is args-first

The call is the unit. Each **argument** is either:

- **Static** — a fixed value (text/number/bool/null/object/array; text may embed
  `{{field}}`), or
- **Member input (dynamic)** — its value becomes `{{key}}` and the row expands to that
  input's config inline (label, type, required, help, validation). The input's **name
  is the argument key**; renaming the key renames the input.

Inputs are **derived from placeholders**: anything you reference (`{{x}}` in a static
value or in `summary`) auto-creates input `x`. Inputs referenced only inside a composed
value — or added manually — appear under **Other inputs**; an input no argument
references is flagged **Unused** (collected but not sent — used for acknowledgment
toggles or forward-compat).

### Code mode

A JSON textarea over the same manifest, with live validation. Useful for paste and
power edits. Switching Code → Visual needs only valid JSON (a partial manifest hydrates
with blanks); Visual → Code serializes the draft back.

## Build one with an AI assistant

Non-developers can generate a manifest by describing the proposal in plain English. The
self-contained, distributable skill at
[`docs/trezu-custom-proposal-template/`](./trezu-custom-proposal-template/SKILL.md)
installs into Claude Code / Claude.ai / Codex (see its `README`) and produces a manifest
to paste into the **Code** tab — it needs no repo access.

## Permissions

- **Authoring** (create / update / delete a template) is gated on the DAO's on-chain
  **`ChangePolicy`** permission — the governance bar, not mere membership.
- **Listing / filling** a template is gated on **membership**.
- Filing the proposal still goes through the DAO's normal `add_proposal` →
  approvals → execution. A template grants no authority.

## Where the code lives

Backend (`nt-be`):
- `src/handlers/proposal_templates.rs` — CRUD at `/api/treasury/{dao_id}/proposal-templates`,
  `validate_manifest` (structural + slug/reserved checks), ChangePolicy-gated writes.
- Migration: `proposal_templates` table with a `manifest_id` generated column
  (`manifest->>'id'`), unique per DAO.

Frontend (`nt-fe/features/proposal-templates/`):
- `manifest.ts` — the zod schema + `parseManifest`, `manifestPlaceholders`,
  `substitutePlaceholders`, `manifestIdOf`, reserved slugs.
- `build-proposal.ts` — the engine: manifest + values → `{ kind, description }`.
- `form-schema.ts` — manifest → react-hook-form zod schema (the fill form).
- `components/manifest-form.tsx` — the fill-form renderer.
- `draft.ts` — the visual builder's editable model (`ManifestDraft` ↔ manifest,
  `normalizeFields`, the `ArgNode` args tree).
- `args-node.ts`, `error-map.ts` — args value-type helpers; per-input error routing.
- `components/{template-editor,visual-builder,fields-builder,args-tree-editor}.tsx` —
  the Code/Visual authoring UI.

Routes (`nt-fe/app/(treasury)/[treasuryId]/custom-templates/`):
`index` · `[slug]` (fill + file) · `create` · `[slug]/edit` · `about` (in-app DSL docs).
