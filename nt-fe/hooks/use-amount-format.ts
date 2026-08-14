"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import {
    type FiatValueOptions,
    formatFiatValue,
    formatPercent,
    formatRate,
    formatRawTokenQuantity,
    formatTokenQuantity,
    formatUnitPrice,
    type PercentOptions,
    type RateOptions,
    type TokenQuantityOptions,
    type UnitPriceOptions,
} from "@/lib/amount-format";

/** Locale-bound formatters for monetary values embedded in larger strings. */
export function useAmountFormat() {
    const locale = useLocale();

    return useMemo(
        () => ({
            locale,
            token: (
                value: Parameters<typeof formatTokenQuantity>[0],
                options: Omit<TokenQuantityOptions, "locale"> = {},
            ) => formatTokenQuantity(value, { ...options, locale }),
            rawToken: (
                raw: Parameters<typeof formatRawTokenQuantity>[0],
                tokenDecimals: number,
                options: Omit<
                    TokenQuantityOptions,
                    "locale" | "tokenDecimals"
                > = {},
            ) =>
                formatRawTokenQuantity(raw, tokenDecimals, {
                    ...options,
                    locale,
                }),
            fiat: (
                value: Parameters<typeof formatFiatValue>[0],
                options: Omit<FiatValueOptions, "locale"> = {},
            ) => formatFiatValue(value, { ...options, locale }),
            unitPrice: (
                value: Parameters<typeof formatUnitPrice>[0],
                options: Omit<UnitPriceOptions, "locale"> = {},
            ) => formatUnitPrice(value, { ...options, locale }),
            rate: (
                value: Parameters<typeof formatRate>[0],
                options: Omit<RateOptions, "locale"> = {},
            ) => formatRate(value, { ...options, locale }),
            percent: (
                value: Parameters<typeof formatPercent>[0],
                options: Omit<PercentOptions, "locale"> = {},
            ) => formatPercent(value, { ...options, locale }),
        }),
        [locale],
    );
}
