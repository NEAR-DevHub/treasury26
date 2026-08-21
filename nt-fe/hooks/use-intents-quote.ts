"use client";

import * as Sentry from "@sentry/nextjs";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";
import type { Token } from "@/components/token-input";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { getAddressPattern } from "@/lib/address-validation";
import { getIntentsQuote, type IntentsQuoteResponse } from "@/lib/api";
import Big from "@/lib/big";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { isIntentsToken } from "@/lib/intents-fee";
import { isNearComNetwork } from "@/lib/intents-network";
import {
    isEthImplicitNearAddress,
    isValidNearAddressFormat,
} from "@/lib/near-validation";
import {
    hasNearComAddressPrefix,
    stripNearComAddressPrefix,
} from "@/lib/nearcom-address";
import { nanosToMs } from "@/lib/utils";

export type IntentsAmountMode = "recipient" | "total";

function isAddressValidForToken(address: string, token: Token): boolean {
    if (!address) return false;
    const accountId = stripNearComAddressPrefix(address);
    const blockchain = getBlockchainType(token.network);
    if (blockchain === NEAR_NETWORK_ID)
        return isValidNearAddressFormat(accountId);
    if (blockchain === "unknown") {
        if (hasNearComAddressPrefix(address)) {
            return isValidNearAddressFormat(accountId);
        }
        return accountId.length > 0;
    }
    const pattern = getAddressPattern(blockchain);
    return pattern ? pattern.test(accountId) : true;
}

export function buildIntentsQuoteRequest(
    treasuryId: string,
    token: Token,
    address: string,
    parsedAmount: string,
    isConfidential: boolean,
    proposalPeriod: string,
    amountMode: IntentsAmountMode = "recipient",
    destinationNetwork?: string,
    isPayment: boolean = false,
    options?: {
        /** 1Click routing id for cross-chain destination (may be `1cs_v1:`) */
        destinationQuoteAssetId?: string;
    },
) {
    const deadlineMs = nanosToMs(proposalPeriod);

    // ORIGIN_CHAIN for native-NEAR/NEAR-FT tokens (funds arrive via ft_transfer
    // on the NEAR blockchain).  INTENTS for Intents tokens (funds arrive via
    // mt_transfer on intents.near).  Confidential always uses the confidential
    // variant regardless of residency.
    const depositType = isConfidential
        ? ("CONFIDENTIAL_INTENTS" as const)
        : token.residency === "Intents"
          ? ("INTENTS" as const)
          : ("ORIGIN_CHAIN" as const);

    // Payments require an explicit destination — never treat "" as near.com
    // (that fetched 1Click with a bad route and blocked the form).
    // Non-payment flows may still omit destination and default to near.com.
    const isNearComRoute = isPayment
        ? isNearComNetwork(destinationNetwork)
        : !destinationNetwork || isNearComNetwork(destinationNetwork);
    const recipientType = isNearComRoute
        ? isConfidential
            ? ("CONFIDENTIAL_INTENTS" as const)
            : ("INTENTS" as const)
        : ("DESTINATION_CHAIN" as const);

    // Held balance id for INTENTS origin.
    const originAsset = token.balanceAssetId || token.address;

    // near.com / INTENTS receive → same holdable balance id (never a chain 1cs).
    // External receiver network → 1Click routing id for that network
    // (caller passes destinationQuoteAssetId from the selected network).
    const destinationAsset = isNearComRoute
        ? originAsset
        : (options?.destinationQuoteAssetId ?? destinationNetwork!);
    // 1Click wants the bare account — nearcom: is FE routing/display only.
    const bareRecipient = stripNearComAddressPrefix(address.trim());
    const normalizedRecipient = isEthImplicitNearAddress(bareRecipient)
        ? bareRecipient.toLowerCase()
        : bareRecipient;

    return {
        daoId: treasuryId,
        swapType: amountMode === "recipient" ? "EXACT_OUTPUT" : "EXACT_INPUT",
        slippageTolerance: 0,
        originAsset,
        depositType,
        destinationAsset,
        amount: parsedAmount,
        refundTo: treasuryId,
        refundType: depositType,
        recipient: normalizedRecipient,
        recipientType,
        deadline: new Date(Date.now() + deadlineMs).toISOString(),
        quoteWaitingTimeMs: 0,
        isPayment,
    };
}

function formatErrorMessage(
    message: string,
    tokenDecimals: number,
    tokenSymbol: string,
    t: ReturnType<typeof useTranslations>,
) {
    const lower = message.toLowerCase();

    if (
        lower.includes("amount is too low") ||
        lower.includes("at least ") ||
        lower.includes("increase the amount")
    ) {
        const match = message.match(/at least\s+([0-9]+(?:\.[0-9]+)?)/i);
        if (match?.[1]) {
            try {
                const threshold = Big(match[1]);
                const parsedAmount = match[1].includes(".")
                    ? threshold
                    : threshold.div(Big(10).pow(tokenDecimals));
                const formatted = parsedAmount
                    .toFixed(tokenDecimals)
                    .replace(/\.?0+$/, "");

                return t("amountTooLowWithMin", {
                    min: formatted,
                    token: tokenSymbol,
                });
            } catch {
                // Fall through to default low-amount message.
            }
        }

        return t("amountTooLow");
    }

    if (
        lower.includes("no route") ||
        lower.includes("no quote") ||
        lower.includes("no liquidity") ||
        lower.includes("insufficient liquidity") ||
        lower.includes("liquidity unavailable")
    ) {
        return t("noRoute");
    }

    return t("fetchFailed");
}

function isInvalidRecipientAddressError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("recipient is not valid") ||
        lower.includes("invalid recipient")
    );
}

interface UseIntentsQuoteParams {
    treasuryId: string | undefined;
    /** Null while the page waits to seed a default token. */
    token: Token | null;
    amount: string;
    destinationAmountDecimals?: number;
    address: string;
    isConfidential: boolean;
    proposalPeriod?: string;
    feeErrorMessage?: string | null;
    amountMode?: IntentsAmountMode;
    destinationNetwork?: string;
    /** 1Click routing id for cross-chain destination (may be `1cs_v1:`) */
    destinationQuoteAssetId?: string;
    isPayment?: boolean;
    /** When false, the quote is never fetched (e.g. the action is paused). */
    enabled?: boolean;
}

export function useIntentsQuote({
    treasuryId,
    token,
    amount,
    destinationAmountDecimals,
    address,
    isConfidential,
    proposalPeriod,
    feeErrorMessage,
    amountMode = "recipient",
    destinationNetwork,
    destinationQuoteAssetId,
    isPayment = false,
    enabled = true,
}: UseIntentsQuoteParams) {
    const t = useTranslations("intentsQuote");
    const isIntents = !!token && isIntentsToken(token);
    const normalizedAddress = address.trim();
    const [debouncedAddress] = useDebounce(normalizedAddress, 300);
    const [debouncedAmount] = useDebounce(amount, 400);
    const [isEnsuring, setIsEnsuring] = useState(false);
    const requiresDestinationAmountDecimals =
        amountMode === "recipient" &&
        !!destinationNetwork &&
        !isNearComNetwork(destinationNetwork);
    const requestAmountDecimals = requiresDestinationAmountDecimals
        ? destinationAmountDecimals
        : token?.decimals;

    const isRecipientReady =
        !!token &&
        !!debouncedAddress &&
        isAddressValidForToken(debouncedAddress, token);
    const hasDestinationNetwork = !!destinationNetwork?.trim();
    // Payments: never quote without a destination (empty used to default to
    // near.com inside buildIntentsQuoteRequest and surface recipient errors).
    const requiresDestinationSelectionForPayment = isPayment && isIntents;
    const isQuoteReady =
        enabled &&
        !!token &&
        isIntents &&
        !!treasuryId &&
        isRecipientReady &&
        !!debouncedAmount &&
        Number(debouncedAmount) > 0 &&
        !!proposalPeriod &&
        (!requiresDestinationSelectionForPayment || hasDestinationNetwork) &&
        !feeErrorMessage;
    const missingRequiredDecimalsForQuote =
        isQuoteReady && requestAmountDecimals === undefined;
    const captureMissingDestinationDecimals = useCallback(
        (tokenAddress: string) => {
            Sentry.captureException(
                new Error(
                    `Blocked EXACT_OUTPUT quote: missing destination decimals (token=${tokenAddress}, destination=${destinationNetwork ?? "unknown"})`,
                ),
            );
        },
        [destinationNetwork],
    );

    const {
        data: quote,
        isLoading,
        isFetching,
        isError: hasQueryError,
        error,
    } = useQuery({
        queryKey: [
            "paymentLiveQuote",
            treasuryId,
            token?.address,
            debouncedAmount,
            debouncedAddress,
            amountMode,
            destinationNetwork,
            destinationQuoteAssetId,
            isPayment,
        ],
        queryFn: async ({ signal }): Promise<IntentsQuoteResponse | null> => {
            if (!isQuoteReady || !token) return null;
            if (requestAmountDecimals === undefined) {
                captureMissingDestinationDecimals(token.address);
                throw new Error(t("fetchFailed"));
            }
            const parsedAmount = Big(debouncedAmount)
                .mul(Big(10).pow(requestAmountDecimals))
                .toFixed();
            return getIntentsQuote(
                buildIntentsQuoteRequest(
                    treasuryId,
                    token,
                    debouncedAddress,
                    parsedAmount,
                    isConfidential,
                    proposalPeriod,
                    amountMode,
                    destinationNetwork,
                    isPayment,
                    { destinationQuoteAssetId },
                ),
                false,
                signal,
            );
        },
        enabled: isQuoteReady,
        refetchOnWindowFocus: false,
        retry: false,
    });

    // Don't surface stale 1Click errors after destination/address is cleared —
    // those blocked "continue" while the user was still editing.
    const hasError =
        isQuoteReady && (hasQueryError || missingRequiredDecimalsForQuote);

    const errorMessage = useMemo(() => {
        if (!isQuoteReady) return null;
        if (missingRequiredDecimalsForQuote) {
            return t("fetchFailed");
        }

        if (!hasQueryError || !error || !token) return null;
        const msg =
            error instanceof Error
                ? error.message
                : "Failed to prepare 1Click transfer route";
        return formatErrorMessage(
            msg,
            requestAmountDecimals as number,
            token.symbol,
            t,
        );
    }, [
        isQuoteReady,
        missingRequiredDecimalsForQuote,
        hasQueryError,
        error,
        requestAmountDecimals,
        token,
        t,
    ]);

    const hasInvalidRecipientAddressError = useMemo(() => {
        if (!hasError || !error) return false;
        const rawMessage =
            error instanceof Error
                ? error.message
                : "Failed to prepare 1Click transfer route";
        return isInvalidRecipientAddressError(rawMessage);
    }, [hasError, error]);

    const isSyncPending =
        amount !== debouncedAmount || normalizedAddress !== debouncedAddress;

    const ensureBeforeReview = useCallback(
        async (formValues: {
            token: Token;
            address: string;
            amount: string;
        }): Promise<{
            ok: boolean;
            quote?: IntentsQuoteResponse | null;
            error?: string;
        }> => {
            if (!isIntents) return { ok: true };

            if (!treasuryId || !proposalPeriod) {
                return {
                    ok: false,
                    error: t("initializing"),
                };
            }

            if (feeErrorMessage) return { ok: false };
            if (
                requiresDestinationSelectionForPayment &&
                !destinationNetwork?.trim()
            ) {
                return { ok: false };
            }

            if (requestAmountDecimals === undefined) {
                captureMissingDestinationDecimals(formValues.token.address);
                return {
                    ok: false,
                    error: t("fetchFailed"),
                };
            }

            if (quote && !isLoading && !isFetching && !isSyncPending) {
                return { ok: true, quote };
            }

            setIsEnsuring(true);
            try {
                const immediateParsed = Big(formValues.amount)
                    .mul(Big(10).pow(requestAmountDecimals))
                    .toFixed();

                const freshQuote = await getIntentsQuote(
                    buildIntentsQuoteRequest(
                        treasuryId,
                        formValues.token,
                        formValues.address.trim(),
                        immediateParsed,
                        isConfidential,
                        proposalPeriod,
                        amountMode,
                        destinationNetwork,
                        isPayment,
                        { destinationQuoteAssetId },
                    ),
                    false,
                );

                if (!freshQuote) {
                    return {
                        ok: false,
                        error: t("noRoute"),
                    };
                }

                return { ok: true, quote: freshQuote };
            } catch (err) {
                const msg =
                    err instanceof Error
                        ? formatErrorMessage(
                              err.message,
                              requestAmountDecimals,
                              formValues.token.symbol,
                              t,
                          )
                        : t("fetchFailed");
                return { ok: false, error: msg };
            } finally {
                setIsEnsuring(false);
            }
        },
        [
            isIntents,
            treasuryId,
            proposalPeriod,
            feeErrorMessage,
            quote,
            isLoading,
            isFetching,
            isSyncPending,
            isConfidential,
            amountMode,
            destinationNetwork,
            destinationQuoteAssetId,
            requiresDestinationSelectionForPayment,
            requestAmountDecimals,
            captureMissingDestinationDecimals,
            t,
            isPayment,
        ],
    );

    return {
        quote,
        isLoading,
        isFetching,
        isEnsuring,
        isSyncPending,
        hasError,
        errorMessage,
        hasInvalidRecipientAddressError,
        isIntents,
        ensureBeforeReview,
    };
}
