"use client";

import { useCallback, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { getAddressPattern } from "@/lib/address-validation";
import Big from "@/lib/big";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { isNearComNetwork } from "@/lib/intents-network";
import {
    isEthImplicitNearAddress,
    isValidNearAddressFormat,
} from "@/lib/near-validation";
import { getIntentsQuote, type IntentsQuoteResponse } from "@/lib/api";
import { formatBalance, nanosToMs } from "@/lib/utils";
import type { Token } from "@/components/token-input";
import { isIntentsToken } from "@/lib/intents-fee";

export type IntentsAmountMode = "recipient" | "total";
const MAX_FEE_TO_RECIPIENT_RATIO = Big(1);

function isAddressValidForToken(address: string, token: Token): boolean {
    if (!address) return false;
    const blockchain = getBlockchainType(token.network);
    if (blockchain === NEAR_NETWORK_ID)
        return isValidNearAddressFormat(address);
    if (blockchain === "unknown") return true;
    const pattern = getAddressPattern(blockchain);
    return pattern ? pattern.test(address) : true;
}

export function buildIntentsQuoteRequest(
    treasuryId: string,
    token: Token,
    address: string,
    parsedAmount: string,
    isConfidential: boolean,
    proposalPeriod?: string,
    amountMode: IntentsAmountMode = "recipient",
    destinationNetwork?: string,
    isPayment: boolean = false,
) {
    const deadlineMs = proposalPeriod
        ? nanosToMs(proposalPeriod)
        : 24 * 60 * 60 * 1000;

    // ORIGIN_CHAIN for native-NEAR/NEAR-FT tokens (funds arrive via ft_transfer
    // on the NEAR blockchain).  INTENTS for Intents tokens (funds arrive via
    // mt_transfer on intents.near).  Confidential always uses the confidential
    // variant regardless of residency.
    const depositType = isConfidential
        ? ("CONFIDENTIAL_INTENTS" as const)
        : token.residency === "Intents"
          ? ("INTENTS" as const)
          : ("ORIGIN_CHAIN" as const);

    // Empty destinationNetwork = no explicit selection. Only near.com is
    // user-selectable today, so default to it.
    const isNearComRoute =
        !destinationNetwork || isNearComNetwork(destinationNetwork);
    const recipientType = isNearComRoute
        ? isConfidential
            ? ("CONFIDENTIAL_INTENTS" as const)
            : ("INTENTS" as const)
        : ("DESTINATION_CHAIN" as const);

    // near.com → keep origin token address (stays on Intents).
    // Other networks → destinationNetwork IS the bridge network id (e.g.
    // `nep141:usdc-eth.omft.near`) and serves as the destinationAsset.
    const destinationAsset = isNearComRoute
        ? token.address
        : destinationNetwork!;
    const normalizedRecipient = isEthImplicitNearAddress(address)
        ? address.toLowerCase()
        : address;

    return {
        daoId: treasuryId,
        swapType: amountMode === "recipient" ? "EXACT_OUTPUT" : "EXACT_INPUT",
        slippageTolerance: 0,
        originAsset: token.address,
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

    if (lower.includes("no route") || lower.includes("no quote")) {
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
    token: Token;
    amount: string;
    destinationAmountDecimals?: number;
    address: string;
    isConfidential: boolean;
    proposalPeriod?: string;
    feeErrorMessage?: string | null;
    amountMode?: IntentsAmountMode;
    destinationNetwork?: string;
    isPayment?: boolean;
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
    isPayment = false,
}: UseIntentsQuoteParams) {
    const t = useTranslations("intentsQuote");
    const isIntents = isIntentsToken(token);
    const [debouncedAddress] = useDebounce(address, 300);
    const [debouncedAmount] = useDebounce(amount, 400);
    const [isEnsuring, setIsEnsuring] = useState(false);
    const requiresDestinationAmountDecimals =
        amountMode === "recipient" &&
        !!destinationNetwork &&
        !isNearComNetwork(destinationNetwork);
    const requestAmountDecimals = requiresDestinationAmountDecimals
        ? destinationAmountDecimals
        : token.decimals;

    const isRecipientReady =
        !!debouncedAddress && isAddressValidForToken(debouncedAddress, token);
    const isQuoteReady =
        isIntents &&
        !!treasuryId &&
        isRecipientReady &&
        !!debouncedAmount &&
        Number(debouncedAmount) > 0 &&
        !!proposalPeriod &&
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
            token.address,
            debouncedAmount,
            debouncedAddress,
            amountMode,
            destinationNetwork,
            isPayment,
        ],
        queryFn: async (): Promise<IntentsQuoteResponse | null> => {
            if (!isQuoteReady) return null;
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
                ),
                false,
            );
        },
        enabled: isQuoteReady,
        refetchOnWindowFocus: false,
        retry: false,
    });

    // In recipient mode (EXACT_OUTPUT), some routes return a quote but with
    // disproportionately high fees; treat those as "amount too low" in UI.
    const lowAmountQuoteDetails = useMemo(() => {
        if (amountMode !== "recipient" || !quote?.quote) return false;

        const amountInRaw = quote.quote.minAmountIn ?? quote.quote.amountIn;
        const amountOutRaw = quote.quote.minAmountOut ?? quote.quote.amountOut;

        if (!amountInRaw || !amountOutRaw) return null;

        try {
            if (requestAmountDecimals === undefined) return null;

            const amountIn = Big(amountInRaw).div(Big(10).pow(token.decimals));
            const amountOut = Big(amountOutRaw).div(
                Big(10).pow(requestAmountDecimals),
            );

            if (amountOut.lte(0)) return null;

            const fee = amountIn.minus(amountOut);
            const feeToRecipientRatio = fee.div(amountOut);

            // Treat routes where fee exceeds recipient amount as too low.
            if (!feeToRecipientRatio.gt(MAX_FEE_TO_RECIPIENT_RATIO)) {
                return null;
            }

            const feeAmount = fee
                .toFixed(requestAmountDecimals)
                .replace(/\.?0+$/, "");

            return {
                feeAmount,
            };
        } catch {
            return null;
        }
    }, [amountMode, quote, token.decimals, requestAmountDecimals]);

    const hasLowAmountQuote = !!lowAmountQuoteDetails;

    const hasError =
        hasQueryError || hasLowAmountQuote || missingRequiredDecimalsForQuote;

    const errorMessage = useMemo(() => {
        if (hasLowAmountQuote) {
            if (lowAmountQuoteDetails) {
                return t("amountTooLowWithMin", {
                    min: lowAmountQuoteDetails.feeAmount,
                    token: token.symbol,
                });
            }
            return t("amountTooLow");
        }

        if (missingRequiredDecimalsForQuote) {
            return t("fetchFailed");
        }

        if (!hasQueryError || !error) return null;
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
        hasLowAmountQuote,
        lowAmountQuoteDetails,
        missingRequiredDecimalsForQuote,
        hasQueryError,
        error,
        requestAmountDecimals,
        token.symbol,
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
        amount !== debouncedAmount || address !== debouncedAddress;

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

            if (requestAmountDecimals === undefined) {
                captureMissingDestinationDecimals(formValues.token.address);
                return {
                    ok: false,
                    error: t("fetchFailed"),
                };
            }

            if (quote && !isLoading && !isFetching && !isSyncPending) {
                if (hasLowAmountQuote) {
                    if (lowAmountQuoteDetails) {
                        return {
                            ok: false,
                            error: t("amountTooLowWithMin", {
                                min: lowAmountQuoteDetails.feeAmount,
                                token: formValues.token.symbol,
                            }),
                        };
                    }
                    return { ok: false, error: t("amountTooLow") };
                }
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
                        formValues.address,
                        immediateParsed,
                        isConfidential,
                        proposalPeriod,
                        amountMode,
                        destinationNetwork,
                        isPayment,
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
            hasLowAmountQuote,
            lowAmountQuoteDetails,
            requestAmountDecimals,
            captureMissingDestinationDecimals,
            t,
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
