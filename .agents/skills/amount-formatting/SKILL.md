---
name: amount-formatting
description: How to display and convert token amounts, fiat values, prices, rates, and percentages in nt-fe. Use whenever frontend work shows a monetary/numeric value in the UI, converts between base units and decimals, or parses amounts from chain data or user input.
---

# Universal Amount Formatting (nt-fe)

All monetary display in the frontend goes through **one library**: `nt-fe/lib/amount-format.ts`. Avoid formatting monetary amounts ad hoc (`toFixed`, `toLocaleString`, or `Intl.NumberFormat` in JSX) and do not use the retired legacy formatters (`formatBalance`, `formatSmartAmount`, `formatTokenAmount`, `formatCurrency`, etc.).

## Core rules (never break these)

1. **All math in Big.js, never JS numbers.** Import from `@/lib/big` (sets `Big.DP = 24` so NEAR's 24-decimal division is exact).
2. **Every formatter returns `{ display, exact, wasRounded, isBelowThreshold }`.**
   - `display` — localized, grouped, rounded. **For eyeballs only. A dead end.** It may contain commas, `—`, `<0.01`, locale decimal commas. Never feed it into `Big()`, inputs, form state, comparisons, API payloads, or transactions.
   - `exact` — canonical ungrouped decimal string. Use for copy buttons and anywhere the true value is needed as a string.
3. **Format only at the render boundary.** Form state, hooks, and data models carry exact decimal strings (`big.toFixed()`) or raw base-unit strings — never pre-formatted display strings.
4. **Non-zero never renders as "0"** (renders `<0.00000001` instead); **missing/invalid renders `—`**, never a fake "0". Missing ≠ zero.
5. **Rounding direction is a product decision, pass it explicitly where it matters:**
   - Balances, "minimum received", max spendable → `rounding: "down"` (never overstate what the user has/gets)
   - Fees, costs, minimum-deposit requirements, shortfalls → `rounding: "up"` (never understate what's needed)
   - Neutral informational display → default `"half-up"`

## Choosing an API

In JSX (preferred, ~90% of cases) — `FormattedAmount` from `@/components/formatted-amount` picks up the user's locale automatically:

```tsx
<FormattedAmount kind="token" value={decimalAmount} symbol="NEAR" tokenDecimals={24} unitPriceUsd={price} />
<FormattedAmount kind="raw-token" value={rawBaseUnits} symbol="USDC" tokenDecimals={6} />
<FormattedAmount kind="fiat" value={usdValue} />
<FormattedAmount kind="unit-price" value={tokenPrice} />
<FormattedAmount kind="rate" value={rate} />
<FormattedAmount kind="percent" value={apyAlready0to100} />
```

Inside translated strings / sentences — `useAmountFormat()` from `@/hooks/use-amount-format` (locale-bound `token()`, `fiat()`, `percent()`, …).

Non-React code — import functions from `@/lib/amount-format` and pass `locale` through as a parameter (default is `en-US`).

`kind="token"` expects a **decimal** amount; `kind="raw-token"` expects **raw base units** and requires `tokenDecimals`. `formatPercent` expects the 0–100 scale (pass `12.5` for 12.5%, not `0.125`).

## Precision model (why you pass `unitPriceUsd`)

Displayed decimals = max(significant digits from profile, decimals needed for $0.01 accuracy from `unitPriceUsd`), capped at 8 fraction digits (or the token's own decimals if fewer).

- `profile: "compact"` — 4 significant digits (dense tables, activity rows)
- `profile: "standard"` — 6 significant digits (default)
- `profile: "exact"` — no rounding (receipts, copy views)

Always pass `unitPriceUsd` when you have a price: it makes expensive tokens (BTC) show more decimals and stablecoins show 2, automatically.

## Conversions and parsing untrusted data

Throwing (use only when input is known-valid; invalid input is a programmer error):
- `decimalFromBaseUnits(raw, decimals)` — raw chain integer → decimal Big
- `baseUnitsFromDecimal(value, decimals)` — decimal → base units Big

Tolerant (use for **anything from chain data, decoded proposal args, quotes, or user input** — return `null` instead of throwing so a bad value degrades one field, not the whole render):
- `decimalOrNull(value)`
- `decimalFromBaseUnitsOrNull(raw, decimals)`
- `legacyGroupedDecimalOrNull(value)` — read-compat for values persisted by the old en-US formatter (accepts `"1,234.56"`); use ONLY for legacy on-chain/description data, never for user or localized input.

Serializing base units for transactions/APIs: always `big.toFixed(0)`, **never** `big.toString()` — `toString()` emits `"2e+27"` exponent notation above 1e21 (Big.PE), which breaks payloads. Also guard that user input doesn't have more decimals than the token (`baseUnitsFromDecimal` does not truncate; fractional base units are invalid on-chain).

## Known pitfalls (each of these was a real bug)

- **Display round-trip**: piping a `display` string back into `Big()` crashes on grouped values (`Big("1,234.56")` throws) and silently double-rounds. If a component receives an amount prop, it must be an exact decimal string or Big.
- **Throwing on untrusted data**: bare `Big(x)` / `decimalFromBaseUnits` in a render path over proposal args, descriptions, or stored quotes = white screen on one malformed value. Use the `OrNull` variants.
- **Tri-state explicit-vs-fallback**: `decimalOrNull` collapses `undefined` into `null`. If "prop not provided" must behave differently from "provided but null/invalid" (e.g. receipt USD fallbacks), test the raw prop with `!== undefined` before parsing.
- **Wrong rounding direction**: a minimum displayed with `rounding: "down"` tells users an amount that is below the real minimum. Think about which direction can't mislead.
- **`Big(0)` is truthy**: use `.gt(0)` / explicit null checks, not truthiness, when deciding whether to show a USD row. Pass `null` (not `Big(0)` or `0`) as the "price unknown" sentinel so the UI hides the row instead of showing "≈$0.00".

## Testing

Unit tests live next to the code (`lib/amount-format.test.ts`, `format-min-deposit.test.ts`, `use-format-quote-amount.test.ts`, `receipt-models.test.ts`); run with `bun test app components features hooks lib` (bare `bun test` wrongly sweeps Playwright e2e specs). When adding a formatter call site that parses external data, add a test with malformed input asserting graceful degradation (`—` / `null`), not a throw.
