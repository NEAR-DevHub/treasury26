"use client";

import { useLocale } from "next-intl";
import {
    type AmountProfile,
    type AmountRounding,
    type AmountSignDisplay,
    type AmountValue,
    type FormattedAmountResult,
    formatFiatValue,
    formatPercent,
    formatRate,
    formatRawTokenQuantity,
    formatTokenQuantity,
    formatUnitPrice,
} from "@/lib/amount-format";

interface CommonProps {
    className?: string;
    locale?: string;
}

interface TokenProps extends CommonProps {
    kind: "token";
    value: AmountValue | null | undefined;
    symbol: string;
    tokenDecimals?: number;
    unitPriceUsd?: AmountValue | null;
    profile?: AmountProfile;
    rounding?: AmountRounding;
    signDisplay?: AmountSignDisplay;
}

interface RawTokenProps extends CommonProps {
    kind: "raw-token";
    value: AmountValue | null | undefined;
    symbol: string;
    tokenDecimals: number;
    unitPriceUsd?: AmountValue | null;
    profile?: AmountProfile;
    rounding?: AmountRounding;
    signDisplay?: AmountSignDisplay;
}

interface FiatProps extends CommonProps {
    kind: "fiat";
    value: AmountValue | null | undefined;
    currency?: string;
    rounding?: AmountRounding;
}

interface UnitPriceProps extends CommonProps {
    kind: "unit-price";
    value: AmountValue | null | undefined;
    currency?: string;
    profile?: AmountProfile;
    rounding?: AmountRounding;
}

interface RateProps extends CommonProps {
    kind: "rate";
    value: AmountValue | null | undefined;
    profile?: AmountProfile;
    rounding?: AmountRounding;
}

interface PercentProps extends CommonProps {
    kind: "percent";
    value: AmountValue | null | undefined;
    rounding?: AmountRounding;
    signDisplay?: AmountSignDisplay;
}

export type FormattedAmountProps =
    | TokenProps
    | RawTokenProps
    | FiatProps
    | UnitPriceProps
    | RateProps
    | PercentProps;

export function FormattedAmount(props: FormattedAmountProps) {
    const activeLocale = useLocale();
    const locale = props.locale ?? activeLocale;

    let result: FormattedAmountResult;
    let suffix = "";

    switch (props.kind) {
        case "token":
            result = formatTokenQuantity(props.value, {
                locale,
                profile: props.profile,
                tokenDecimals: props.tokenDecimals,
                unitPriceUsd: props.unitPriceUsd,
                rounding: props.rounding,
                signDisplay: props.signDisplay,
            });
            suffix = props.symbol ? ` ${props.symbol}` : "";
            break;
        case "raw-token":
            result = formatRawTokenQuantity(props.value, props.tokenDecimals, {
                locale,
                profile: props.profile,
                unitPriceUsd: props.unitPriceUsd,
                rounding: props.rounding,
                signDisplay: props.signDisplay,
            });
            suffix = props.symbol ? ` ${props.symbol}` : "";
            break;
        case "fiat":
            result = formatFiatValue(props.value, {
                locale,
                currency: props.currency,
                rounding: props.rounding,
            });
            break;
        case "unit-price":
            result = formatUnitPrice(props.value, {
                locale,
                currency: props.currency,
                profile: props.profile,
                rounding: props.rounding,
            });
            break;
        case "rate":
            result = formatRate(props.value, {
                locale,
                profile: props.profile,
                rounding: props.rounding,
            });
            break;
        case "percent":
            result = formatPercent(props.value, {
                locale,
                rounding: props.rounding,
                signDisplay: props.signDisplay,
            });
            break;
    }

    return (
        <span className={props.className}>
            {result.display}
            {suffix}
        </span>
    );
}
