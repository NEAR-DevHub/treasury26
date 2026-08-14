import { describe, expect, it } from "bun:test";
import Big from "@/lib/big";
import {
    baseUnitsFromDecimal,
    decimalFromBaseUnits,
    decimalFromBaseUnitsOrNull,
    decimalOrNull,
    formatFiatValue,
    formatPercent,
    formatRate,
    formatRawTokenQuantity,
    formatTokenQuantity,
    formatUnitPrice,
    legacyGroupedDecimalOrNull,
} from "./amount-format";

describe("exact amount conversion", () => {
    it("converts base units without display precision loss", () => {
        expect(
            decimalFromBaseUnits("41985510254136946107590", 24).toFixed(),
        ).toBe("0.04198551025413694610759");
        expect(baseUnitsFromDecimal("0.00000001", 8).toFixed()).toBe("1");
    });

    it("supports zero-decimal and 24-decimal tokens", () => {
        expect(decimalFromBaseUnits("123", 0).toFixed()).toBe("123");
        expect(formatRawTokenQuantity("1", 24).display).toBe("<0.00000001");
    });

    it("keeps strict conversions strict and offers safe read helpers", () => {
        expect(() => decimalFromBaseUnits("not-a-number", 24)).toThrow();
        expect(() => baseUnitsFromDecimal("1,234.56", 6)).toThrow();
        expect(decimalOrNull(Number.NaN)).toBeNull();
        expect(decimalFromBaseUnitsOrNull("bad", 24)).toBeNull();
    });

    it("normalizes only valid legacy comma-grouped decimals", () => {
        expect(legacyGroupedDecimalOrNull("1,234.56")?.toFixed()).toBe(
            "1234.56",
        );
        expect(legacyGroupedDecimalOrNull("1234.56")?.toFixed()).toBe(
            "1234.56",
        );
        expect(legacyGroupedDecimalOrNull("12,34.56")).toBeNull();
        expect(legacyGroupedDecimalOrNull("1.234,56")).toBeNull();
    });
});

describe("token display precision", () => {
    it("keeps about one dollar of BTC meaningful", () => {
        expect(
            formatTokenQuantity("0.00001", {
                profile: "compact",
                tokenDecimals: 8,
                unitPriceUsd: 100_000,
            }).display,
        ).toBe("0.00001");
    });

    it("shows one satoshi and labels values below one satoshi", () => {
        expect(
            formatTokenQuantity("0.00000001", {
                profile: "compact",
                tokenDecimals: 8,
            }).display,
        ).toBe("0.00000001");
        const tiny = formatTokenQuantity("0.000000001", {
            profile: "compact",
            tokenDecimals: 8,
        });
        expect(tiny.display).toBe("<0.00000001");
        expect(tiny.exact).toBe("0.000000001");
        expect(tiny.isBelowThreshold).toBe(true);
    });

    it("uses compact significant precision for recent activity", () => {
        const result = formatTokenQuantity("0.041985510254136946107590", {
            profile: "compact",
            tokenDecimals: 24,
            unitPriceUsd: "1.051121798043976",
        });
        expect(result.display).toBe("0.04199");
        expect(result.exact).toBe("0.04198551025413694610759");
        expect(result.wasRounded).toBe(true);
    });

    it("uses cent accuracy for dollar-like tokens", () => {
        expect(
            formatTokenQuantity("1234.56789", {
                profile: "compact",
                tokenDecimals: 6,
                unitPriceUsd: 1,
            }).display,
        ).toBe("1,234.57");
    });

    it("handles signs, trailing zeros, large integers, and rounding modes", () => {
        expect(formatTokenQuantity("-2.5000").display).toBe("-2.5");
        expect(
            formatTokenQuantity("12345678901234567890", {
                profile: "exact",
            }).display,
        ).toBe("12,345,678,901,234,567,890");
        expect(
            formatTokenQuantity("1.239", {
                profile: "compact",
                tokenDecimals: 2,
                rounding: "down",
            }).display,
        ).toBe("1.23");
        expect(
            formatTokenQuantity("1.231", {
                profile: "compact",
                tokenDecimals: 2,
                rounding: "up",
            }).display,
        ).toBe("1.24");
    });
});

describe("fiat, prices, rates, percentages, and locales", () => {
    it("distinguishes zero, sub-cent, missing, and invalid fiat values", () => {
        expect(formatFiatValue(0).display).toBe("$0.00");
        expect(formatFiatValue("0.004").display).toBe("<$0.01");
        expect(formatFiatValue(null).display).toBe("—");
        expect(formatFiatValue(Number.NaN).display).toBe("—");
        expect(formatFiatValue(Number.POSITIVE_INFINITY).display).toBe("—");
    });

    it("formats unit prices, rates, and small percentages", () => {
        expect(formatUnitPrice("1.23456789").display).toBe("$1.23457");
        expect(formatRate("0.000123456789").display).toBe("0.00012346");
        expect(formatPercent("0.004").display).toBe("<0.01%");
        expect(formatPercent("12.345").display).toBe("12.35%");
    });

    it("localizes separators without converting exact amounts to Number", () => {
        expect(
            formatTokenQuantity(new Big("1234567.89"), {
                profile: "exact",
                locale: "de",
            }).display,
        ).toBe("1.234.567,89");
        expect(formatFiatValue("1234.5", { locale: "es" }).display).toBe(
            "1234,50 US$",
        );
        expect(formatTokenQuantity("1234.5", { locale: "uk" }).display).toBe(
            "1 234,5",
        );
    });

    it("uses locale-specific grouping patterns and numbering systems", () => {
        expect(
            formatTokenQuantity("1234567.89", {
                profile: "exact",
                locale: "hi-IN",
            }).display,
        ).toBe("12,34,567.89");
        expect(
            formatTokenQuantity("1234567.89", {
                profile: "exact",
                locale: "de-CH",
            }).display,
        ).toBe("1’234’567.89");
        expect(
            formatTokenQuantity("1234567.89", {
                profile: "exact",
                locale: "ar-EG",
            }).display,
        ).toBe("١٬٢٣٤٬٥٦٧٫٨٩");
    });

    it("lets Intl place localized currency signs and affixes", () => {
        expect(
            formatFiatValue("1234.5", {
                locale: "de-CH",
                currency: "CHF",
            }).display,
        ).toBe("CHF 1’234.50");
        expect(
            formatFiatValue("-1234.5", {
                locale: "de-CH",
                currency: "CHF",
            }).display,
        ).toBe("CHF-1’234.50");
        expect(
            formatFiatValue("-1234.5", {
                locale: "de-DE",
                currency: "EUR",
            }).display,
        ).toBe("-1.234,50 €");
    });

    it("preserves large and high-precision canonical decimals through Intl", () => {
        expect(
            formatTokenQuantity(
                "12345678901234567890.123456789012345678901234",
                { profile: "exact", locale: "en-US" },
            ).display,
        ).toBe("12,345,678,901,234,567,890.123456789012345678901234");
        expect(
            formatFiatValue("12345678901234567890.125", {
                locale: "en-US",
            }).display,
        ).toBe("$12,345,678,901,234,567,890.13");
    });
});
