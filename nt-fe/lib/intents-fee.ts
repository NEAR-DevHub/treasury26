import { IntentsSDK } from "@defuse-protocol/intents-sdk";
import Big from "@/lib/big";
import { validateAddress } from "@/lib/address-validation";
import type { BlockchainType } from "@/lib/blockchain-utils";
import { formatSmartAmount } from "@/lib/utils";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

const intentsSdk = new IntentsSDK({
    referral: "",
});

export type PaymentBalanceWarningType =
    | "amount_exceeds_balance"
    | "fee_not_covered";

export interface PaymentBalanceWarning {
    type: PaymentBalanceWarningType;
    formattedFee?: string;
    symbol?: string;
}

export function isIntentsToken(token: { address?: string | null }): boolean {
    return (
        !!token.address &&
        (token.address.startsWith("nep141:") ||
            token.address.startsWith("nep245:"))
    );
}

export function isIntentsCrossChainToken(token: {
    address?: string | null;
    network?: string | null;
}): boolean {
    return (
        !!token.address &&
        (token.address.startsWith("nep141:") ||
            token.address.startsWith("nep245:")) &&
        (token.network || "").toLowerCase() !== NEAR_NETWORK_ID
    );
}

export function isNearChainNativeToken(token: {
    address?: string | null;
    network?: string | null;
    residency?: string | null;
}): boolean {
    const address = (token.address || "").toLowerCase();
    const network = (token.network || "").toLowerCase();
    const residency = (token.residency || "").toLowerCase();

    return (
        address === NEAR_NETWORK_ID &&
        (!network || network === NEAR_NETWORK_ID) &&
        (!residency || residency === NEAR_NETWORK_ID)
    );
}

export function isNearChainFtToken(token: {
    address?: string | null;
    network?: string | null;
    residency?: string | null;
}): boolean {
    const address = (token.address || "").toLowerCase();
    const network = (token.network || "").toLowerCase();
    const residency = (token.residency || "").toLowerCase();
    const isNearNetwork = !network || network === NEAR_NETWORK_ID;
    const isNearStyleFtAddress =
        !!address &&
        address !== NEAR_NETWORK_ID &&
        !address.startsWith("nep141:") &&
        !address.startsWith("nep245:");

    return isNearNetwork && (residency === "ft" || isNearStyleFtAddress);
}

function fromAmountRaw(rawAmount: bigint | string, decimals: number): Big {
    return Big(rawAmount.toString()).div(Big(10).pow(decimals));
}

export function computeQuoteNetworkFee(
    args?: {
        amountInFormatted?: string | null;
        amountOutFormatted?: string | null;
    } | null,
): string | undefined {
    try {
        const fee = Big(args?.amountInFormatted || "0").minus(
            Big(args?.amountOutFormatted || "0"),
        );
        return fee.gt(0) ? formatSmartAmount(fee.toString()) : undefined;
    } catch {
        return undefined;
    }
}

export async function estimateIntentsNetworkFee(args: {
    token: {
        address: string;
        decimals: number;
        minWithdrawalAmount?: string;
    };
    destinationAddress: string;
    destinationBlockchain?: BlockchainType;
}): Promise<{ networkFeeRaw: bigint; networkFee: Big }> {
    if (args.destinationBlockchain) {
        const result = validateAddress(
            args.destinationAddress,
            args.destinationBlockchain,
        );
        if (!result.isValid) {
            return {
                networkFeeRaw: 0n,
                networkFee: Big(0),
            };
        }
    }

    const feeEstimation = await intentsSdk.estimateWithdrawalFee({
        withdrawalParams: {
            assetId: args.token.address,
            amount:
                args.token.minWithdrawalAmount &&
                BigInt(args.token.minWithdrawalAmount) > 0n
                    ? BigInt(args.token.minWithdrawalAmount)
                    : 100000000n,
            destinationAddress: args.destinationAddress,
            feeInclusive: false,
        },
    });
    const networkFeeRaw = sumNetworkFees(feeEstimation.underlyingFees);

    return {
        networkFeeRaw,
        networkFee: fromAmountRaw(networkFeeRaw, args.token.decimals),
    };
}

function formatFeeAmountForMessage(value: Big, decimals: number): string {
    const displayDecimals = Math.max(0, Math.min(decimals, 8));
    const smallestDisplayUnit = Big(1).div(Big(10).pow(displayDecimals));
    const formatted = value.toFixed(displayDecimals).replace(/\.?0+$/, "");

    if (formatted && formatted !== "0") {
        return formatted;
    }

    if (value.gt(0)) {
        return `<${smallestDisplayUnit.toFixed(displayDecimals)}`;
    }

    return "0";
}

/** Non-blocking balance warning for payments (amount + fee vs treasury balance). */
export function getPaymentBalanceWarning(args: {
    amount: string;
    balance: Big;
    networkFee?: Big;
    decimals: number;
    symbol: string;
}): PaymentBalanceWarning | null {
    let enteredAmount: Big;
    try {
        enteredAmount = Big(args.amount);
    } catch {
        return null;
    }

    if (!enteredAmount.gt(0)) {
        return null;
    }

    if (enteredAmount.gt(args.balance)) {
        return { type: "amount_exceeds_balance" };
    }

    if (args.networkFee?.gt(0)) {
        const totalRequired = enteredAmount.plus(args.networkFee);
        if (totalRequired.gt(args.balance)) {
            return {
                type: "fee_not_covered",
                formattedFee: formatFeeAmountForMessage(
                    args.networkFee,
                    args.decimals,
                ),
                symbol: args.symbol,
            };
        }
    }

    return null;
}

export function sumNetworkFees(underlyingFees: unknown): bigint {
    if (!underlyingFees || typeof underlyingFees !== "object") {
        return 0n;
    }

    let networkFeeRaw = 0n;

    const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;

        for (const [key, nestedValue] of Object.entries(
            value as Record<string, unknown>,
        )) {
            if (typeof nestedValue === "bigint") {
                if (key.endsWith("Fee")) {
                    networkFeeRaw += nestedValue;
                }
                continue;
            }

            walk(nestedValue);
        }
    };

    walk(underlyingFees);
    return networkFeeRaw;
}
