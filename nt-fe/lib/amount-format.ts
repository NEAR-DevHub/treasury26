import Big from "@/lib/big";

export type AmountValue = string | number | Big;
export type AmountProfile = "compact" | "standard" | "exact";
export type AmountRounding = "half-up" | "down" | "up";
export type AmountSignDisplay = "auto" | "always" | "never";

export interface FormattedAmountResult {
    /** Localized, presentation-only value. */
    display: string;
    /** Canonical, ungrouped decimal value suitable for copying. */
    exact: string;
    wasRounded: boolean;
    isBelowThreshold: boolean;
}

export interface TokenQuantityOptions {
    profile?: AmountProfile;
    tokenDecimals?: number;
    unitPriceUsd?: AmountValue | null;
    locale?: string;
    rounding?: AmountRounding;
    signDisplay?: AmountSignDisplay;
}

export interface FiatValueOptions {
    currency?: string;
    locale?: string;
    rounding?: AmountRounding;
}

export interface UnitPriceOptions extends FiatValueOptions {
    profile?: AmountProfile;
}

export interface RateOptions {
    locale?: string;
    profile?: AmountProfile;
    rounding?: AmountRounding;
}

export interface PercentOptions {
    locale?: string;
    rounding?: AmountRounding;
    signDisplay?: AmountSignDisplay;
}

const INVALID_DISPLAY = "—";
const DISPLAY_FRACTION_CAP = 8;
const FIAT_FRACTION_DIGITS = 2;
const PERCENT_FRACTION_DIGITS = 2;
const SIGNIFICANT_DIGITS: Record<Exclude<AmountProfile, "exact">, number> = {
    compact: 4,
    standard: 6,
};

function assertDecimals(decimals: number): void {
    if (!Number.isInteger(decimals) || decimals < 0) {
        throw new RangeError("Token decimals must be a non-negative integer");
    }
}

/** Parse an ungrouped canonical decimal without throwing. */
export function decimalOrNull(
    value: AmountValue | null | undefined,
): Big | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;

    try {
        const parsed = value instanceof Big ? value : Big(value.toString());
        return parsed;
    } catch {
        return null;
    }
}

/** Convert untrusted integer base units to a decimal without throwing. */
export function decimalFromBaseUnitsOrNull(
    raw: AmountValue | null | undefined,
    decimals: number,
): Big | null {
    if (raw === null || raw === undefined) return null;

    try {
        return decimalFromBaseUnits(raw, decimals);
    } catch {
        return null;
    }
}

/**
 * Read compatibility for values persisted by the legacy en-US formatter.
 * This intentionally accepts only canonical decimals or correctly grouped
 * comma thousands; localized input must never pass through this helper.
 */
export function legacyGroupedDecimalOrNull(
    value: AmountValue | null | undefined,
): Big | null {
    const canonical = decimalOrNull(value);
    if (canonical) return canonical;
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed)) {
        return null;
    }

    return decimalOrNull(trimmed.replaceAll(",", ""));
}

function canonicalDecimal(value: Big): string {
    const fixed = value.toFixed();
    if (!fixed.includes(".")) return fixed;
    return fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

/** Convert an integer base-unit amount to an exact decimal token quantity. */
export function decimalFromBaseUnits(raw: AmountValue, decimals: number): Big {
    assertDecimals(decimals);
    const parsed = decimalOrNull(raw);
    if (!parsed) throw new TypeError("Invalid base-unit amount");
    return parsed.div(Big(10).pow(decimals));
}

/** Convert a decimal token quantity to base units without display rounding. */
export function baseUnitsFromDecimal(
    value: AmountValue,
    decimals: number,
): Big {
    assertDecimals(decimals);
    const parsed = decimalOrNull(value);
    if (!parsed) throw new TypeError("Invalid decimal token amount");
    return parsed.mul(Big(10).pow(decimals));
}

interface LocaleSymbols {
    decimal: string;
    group: string;
    minus: string;
    plus: string;
}

function localeSymbols(locale: string): LocaleSymbols {
    const parts = new Intl.NumberFormat(locale, {
        signDisplay: "always",
    }).formatToParts(-12345.6);

    return {
        decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
        group: parts.find((part) => part.type === "group")?.value ?? ",",
        minus: parts.find((part) => part.type === "minusSign")?.value ?? "-",
        plus:
            new Intl.NumberFormat(locale, { signDisplay: "always" })
                .formatToParts(1)
                .find((part) => part.type === "plusSign")?.value ?? "+",
    };
}

function groupInteger(integer: string, separator: string): string {
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function localizeCanonical(
    canonical: string,
    locale: string,
    signDisplay: AmountSignDisplay = "auto",
): string {
    const symbols = localeSymbols(locale);
    const negative = canonical.startsWith("-");
    const unsigned = negative ? canonical.slice(1) : canonical;
    const [integer, fraction] = unsigned.split(".");
    const localized = fraction
        ? `${groupInteger(integer, symbols.group)}${symbols.decimal}${fraction}`
        : groupInteger(integer, symbols.group);

    if (signDisplay === "never") return localized;
    if (negative) return `${symbols.minus}${localized}`;
    return signDisplay === "always" ? `${symbols.plus}${localized}` : localized;
}

function invalidResult(): FormattedAmountResult {
    return {
        display: INVALID_DISPLAY,
        exact: "",
        wasRounded: false,
        isBelowThreshold: false,
    };
}

function roundingMode(rounding: AmountRounding): 0 | 1 | 3 {
    if (rounding === "down") return Big.roundDown;
    if (rounding === "up") return Big.roundUp;
    return Big.roundHalfUp;
}

function integerDigits(value: Big): number {
    const fixed = canonicalDecimal(value.abs());
    const integer = fixed.split(".")[0];
    return integer === "0" ? 0 : integer.length;
}

function leadingFractionZeros(value: Big): number {
    const fixed = canonicalDecimal(value.abs());
    const fraction = fixed.split(".")[1] ?? "";
    const firstNonZero = fraction.search(/[1-9]/);
    return firstNonZero < 0 ? 0 : firstNonZero;
}

function decimalsForSignificantDigits(value: Big, significant: number): number {
    if (value.eq(0)) return 0;
    if (value.abs().gte(1)) {
        return Math.max(0, significant - integerDigits(value));
    }
    return leadingFractionZeros(value) + significant;
}

function decimalsForCentAccuracy(unitPriceUsd: Big | null): number {
    if (!unitPriceUsd || unitPriceUsd.lte(0)) return 0;

    const price = Number(unitPriceUsd.toString());
    if (!Number.isFinite(price) || price <= 0) return 0;
    return Math.max(0, Math.ceil(Math.log10(price / 0.01)));
}

function displayFractionCap(tokenDecimals?: number): number {
    if (tokenDecimals === undefined) return DISPLAY_FRACTION_CAP;
    assertDecimals(tokenDecimals);
    return Math.min(tokenDecimals, DISPLAY_FRACTION_CAP);
}

function thresholdDisplay(
    fractionDigits: number,
    locale: string,
    value: Big,
    signDisplay: AmountSignDisplay,
): string {
    const threshold = Big(10).pow(-fractionDigits);
    const localized = localizeCanonical(
        canonicalDecimal(threshold),
        locale,
        "never",
    );
    const symbols = localeSymbols(locale);
    const sign = value.lt(0)
        ? symbols.minus
        : signDisplay === "always"
          ? symbols.plus
          : "";
    return `${sign}<${localized}`;
}

export function formatTokenQuantity(
    value: AmountValue | null | undefined,
    options: TokenQuantityOptions = {},
): FormattedAmountResult {
    const parsed = decimalOrNull(value);
    if (!parsed) return invalidResult();

    const {
        profile = "standard",
        locale = "en-US",
        rounding = "half-up",
        signDisplay = "auto",
        tokenDecimals,
    } = options;
    const exact = canonicalDecimal(parsed);

    if (profile === "exact") {
        return {
            display: localizeCanonical(exact, locale, signDisplay),
            exact,
            wasRounded: false,
            isBelowThreshold: false,
        };
    }

    const cap = displayFractionCap(tokenDecimals);
    const threshold = Big(10).pow(-cap);
    if (parsed.abs().gt(0) && parsed.abs().lt(threshold)) {
        return {
            display: thresholdDisplay(cap, locale, parsed, signDisplay),
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    const price = decimalOrNull(options.unitPriceUsd);
    const fractionDigits = Math.min(
        cap,
        Math.max(
            decimalsForSignificantDigits(parsed, SIGNIFICANT_DIGITS[profile]),
            decimalsForCentAccuracy(price),
        ),
    );
    const rounded = parsed.round(fractionDigits, roundingMode(rounding));
    const roundedCanonical = canonicalDecimal(rounded);

    // The cap check above should normally handle this. Keep the invariant even
    // for unusual rounding/profile combinations: non-zero never renders as 0.
    if (parsed.abs().gt(0) && rounded.eq(0)) {
        return {
            display: thresholdDisplay(cap, locale, parsed, signDisplay),
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    return {
        display: localizeCanonical(roundedCanonical, locale, signDisplay),
        exact,
        wasRounded: !rounded.eq(parsed),
        isBelowThreshold: false,
    };
}

export function formatRawTokenQuantity(
    raw: AmountValue | null | undefined,
    tokenDecimals: number,
    options: Omit<TokenQuantityOptions, "tokenDecimals"> = {},
): FormattedAmountResult {
    if (raw === null || raw === undefined) return invalidResult();
    try {
        return formatTokenQuantity(decimalFromBaseUnits(raw, tokenDecimals), {
            ...options,
            tokenDecimals,
        });
    } catch {
        return invalidResult();
    }
}

function currencyFromCanonical(
    canonical: string,
    locale: string,
    currency: string,
): string {
    const negative = canonical.startsWith("-");
    const unsigned = negative ? canonical.slice(1) : canonical;
    const localizedNumber = localizeCanonical(unsigned, locale, "never");
    const parts = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: DISPLAY_FRACTION_CAP,
    }).formatToParts(negative ? -12345.67 : 12345.67);
    const numericTypes = new Set(["integer", "group", "decimal", "fraction"]);
    const firstNumeric = parts.findIndex((part) => numericTypes.has(part.type));
    let lastNumeric = firstNumeric;
    for (let i = firstNumeric + 1; i < parts.length; i++) {
        if (!numericTypes.has(parts[i].type)) break;
        lastNumeric = i;
    }
    const prefix = parts
        .slice(0, firstNumeric)
        .map((part) => part.value)
        .join("");
    const suffix = parts
        .slice(lastNumeric + 1)
        .map((part) => part.value)
        .join("");
    return `${prefix}${localizedNumber}${suffix}`;
}

export function formatFiatValue(
    value: AmountValue | null | undefined,
    options: FiatValueOptions = {},
): FormattedAmountResult {
    const parsed = decimalOrNull(value);
    if (!parsed) return invalidResult();

    const {
        currency = "USD",
        locale = "en-US",
        rounding = "half-up",
    } = options;
    const exact = canonicalDecimal(parsed);
    const threshold = Big(10).pow(-FIAT_FRACTION_DIGITS);

    if (parsed.abs().gt(0) && parsed.abs().lt(threshold)) {
        const thresholdCurrency = currencyFromCanonical(
            threshold.toFixed(FIAT_FRACTION_DIGITS),
            locale,
            currency,
        );
        return {
            display: `${parsed.lt(0) ? "-" : ""}<${thresholdCurrency}`,
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    const rounded = parsed.round(FIAT_FRACTION_DIGITS, roundingMode(rounding));
    const fixed = rounded.toFixed(FIAT_FRACTION_DIGITS);
    return {
        display: currencyFromCanonical(fixed, locale, currency),
        exact,
        wasRounded: !rounded.eq(parsed),
        isBelowThreshold: false,
    };
}

export function formatUnitPrice(
    value: AmountValue | null | undefined,
    options: UnitPriceOptions = {},
): FormattedAmountResult {
    const parsed = decimalOrNull(value);
    if (!parsed) return invalidResult();

    const {
        currency = "USD",
        locale = "en-US",
        profile = "standard",
        rounding = "half-up",
    } = options;
    const exact = canonicalDecimal(parsed);
    if (profile === "exact") {
        return {
            display: currencyFromCanonical(exact, locale, currency),
            exact,
            wasRounded: false,
            isBelowThreshold: false,
        };
    }

    const cap = DISPLAY_FRACTION_CAP;
    const threshold = Big(10).pow(-cap);
    if (parsed.abs().gt(0) && parsed.abs().lt(threshold)) {
        return {
            display: `${parsed.lt(0) ? "-" : ""}<${currencyFromCanonical(canonicalDecimal(threshold), locale, currency)}`,
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    const fractionDigits = Math.min(
        cap,
        Math.max(
            2,
            decimalsForSignificantDigits(parsed, SIGNIFICANT_DIGITS[profile]),
        ),
    );
    const rounded = parsed.round(fractionDigits, roundingMode(rounding));
    const displayCanonical = rounded.toFixed(
        parsed.abs().gte(0.01) ? Math.max(2, fractionDigits) : fractionDigits,
    );
    return {
        display: currencyFromCanonical(displayCanonical, locale, currency),
        exact,
        wasRounded: !rounded.eq(parsed),
        isBelowThreshold: false,
    };
}

export function formatRate(
    value: AmountValue | null | undefined,
    options: RateOptions = {},
): FormattedAmountResult {
    const parsed = decimalOrNull(value);
    if (!parsed) return invalidResult();

    const {
        locale = "en-US",
        profile = "standard",
        rounding = "half-up",
    } = options;
    const exact = canonicalDecimal(parsed);
    if (profile === "exact") {
        return {
            display: localizeCanonical(exact, locale),
            exact,
            wasRounded: false,
            isBelowThreshold: false,
        };
    }

    const threshold = Big(10).pow(-DISPLAY_FRACTION_CAP);
    if (parsed.abs().gt(0) && parsed.abs().lt(threshold)) {
        return {
            display: `${parsed.lt(0) ? "-" : ""}<${localizeCanonical(canonicalDecimal(threshold), locale, "never")}`,
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    const fractionDigits = Math.min(
        DISPLAY_FRACTION_CAP,
        decimalsForSignificantDigits(parsed, SIGNIFICANT_DIGITS[profile]),
    );
    const rounded = parsed.round(fractionDigits, roundingMode(rounding));
    return {
        display: localizeCanonical(canonicalDecimal(rounded), locale),
        exact,
        wasRounded: !rounded.eq(parsed),
        isBelowThreshold: false,
    };
}

export function formatPercent(
    value: AmountValue | null | undefined,
    options: PercentOptions = {},
): FormattedAmountResult {
    const parsed = decimalOrNull(value);
    if (!parsed) return invalidResult();

    const {
        locale = "en-US",
        rounding = "half-up",
        signDisplay = "auto",
    } = options;
    const exact = canonicalDecimal(parsed);
    const threshold = Big(10).pow(-PERCENT_FRACTION_DIGITS);
    if (parsed.abs().gt(0) && parsed.abs().lt(threshold)) {
        return {
            display: `${thresholdDisplay(PERCENT_FRACTION_DIGITS, locale, parsed, signDisplay)}%`,
            exact,
            wasRounded: true,
            isBelowThreshold: true,
        };
    }

    const rounded = parsed.round(
        PERCENT_FRACTION_DIGITS,
        roundingMode(rounding),
    );
    return {
        display: `${localizeCanonical(canonicalDecimal(rounded), locale, signDisplay)}%`,
        exact,
        wasRounded: !rounded.eq(parsed),
        isBelowThreshold: false,
    };
}
