"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownToLine, Info, Shield } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";

import { AmountSummary } from "@/components/amount-summary";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreateRequestButton } from "@/components/create-request-button";
import { TokenDisplay } from "@/components/token-display-with-network";
import { PageComponentLayout } from "@/components/page-component-layout";
import { SlotWarning } from "@/components/warning-message";
import { PendingButton } from "@/components/pending-button";
import {
    ReviewStep,
    type StepProps,
    StepperHeader,
    StepWizard,
} from "@/components/step-wizard";
import { Textarea } from "@/components/textarea";
import { Tooltip } from "@/components/tooltip";
import { type Token, tokenSchema } from "@/components/token-input";
import { Form, FormField } from "@/components/ui/form";
import { default_near_token } from "@/constants/token";
import { useAddressBook } from "@/features/address-book";
import {
    PAGE_TOUR_NAMES,
    PAGE_TOUR_STORAGE_KEYS,
    useManualPageTour,
    usePageTour,
} from "@/features/onboarding/steps/page-tours";
import { type BridgeAsset, useBridgeTokens } from "@/hooks/use-bridge-tokens";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTreasury } from "@/hooks/use-treasury";
import {
    scopedFieldMessage,
    useBridgeScopedWarning,
    useScopedSlotWarning,
} from "@/hooks/use-warnings";
import { useToken, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import { generateIntent, getIntentsQuote } from "@/lib/api";
import type { IntentsQuoteResponse } from "@/lib/api";
import Big from "@/lib/big";
import { getBlockchainType } from "@/lib/blockchain-utils";
import {
    buildIntentsTransferProposal,
    buildNativeNearIntentsKind,
    buildNearFtIntentsKind,
} from "@/lib/near-proposal-builders";
import {
    isEthImplicitNearAddress,
    isValidNearAddressFormat,
} from "@/lib/near-validation";
import { useNear } from "@/stores/near-store";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
import { PaymentFormSection } from "./components/payment-form-section";
import { Address } from "@/components/address";
import {
    useIntentsQuote,
    buildIntentsQuoteRequest,
} from "@/hooks/use-intents-quote";
import { getNearComChainIcons, isNearComNetwork } from "@/lib/intents-network";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import {
    cn,
    encodeToMarkdown,
    formatBalance,
    formatCurrency,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { findBridgeAssetForToken } from "@/lib/bridge-asset-resolver";
import {
    computeQuoteNetworkFee,
    isIntentsToken,
    isNearChainFtToken,
    isNearChainNativeToken,
} from "@/lib/intents-fee";
import { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import { buildDirectTransferKind } from "./utils/proposal-builder";

function buildPaymentFormSchema(messages: {
    recipientMin: string;
    recipientMax: string;
    amountGreaterThanZero: string;
    recipientSameAsToken: string;
}) {
    return z
        .object({
            address: z
                .string()
                .min(2, messages.recipientMin)
                .max(128, messages.recipientMax),
            destinationNetwork: z.string(),
            destinationNetworkName: z.string(),
            amount: z
                .string()
                .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
                    message: messages.amountGreaterThanZero,
                }),
            memo: z.string().optional(),
            token: tokenSchema,
        })
        .superRefine((data, ctx) => {
            if (data.address === data.token.address) {
                ctx.addIssue({
                    code: "custom",
                    path: ["address"],
                    message: messages.recipientSameAsToken,
                });
            }
        });
}

interface Step1Props extends StepProps {
    feeErrorMessage?: string | null;
    networkFee?: string | null;
    isFeeLoading?: boolean;
    quoteErrorMessage?: string | null;
    hasRestrictedRecipientError?: boolean;
    ensureQuoteBeforeReview?: () => Promise<boolean>;
    onAddressBookSelectionChange?: (isFromAddressBook: boolean) => void;
    bridgeAssets?: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
    paymentsSlotBlocked?: boolean;
    sendWarningMessage?: string | null;
    recipientNetworkWarningMessage?: string | null;
}

function Step1({
    handleNext,
    feeErrorMessage,
    networkFee,
    isFeeLoading,
    quoteErrorMessage,
    hasRestrictedRecipientError,
    ensureQuoteBeforeReview,
    onAddressBookSelectionChange,
    bridgeAssets = [],
    isBridgeAssetsLoading = false,
    paymentsSlotBlocked = false,
    sendWarningMessage = null,
    recipientNetworkWarningMessage = null,
}: Step1Props) {
    const tPay = useTranslations("payments");
    const tCreate = useTranslations("createRequestButton");
    const form = useFormContext<PaymentFormValues>();
    const { treasuryId, isConfidential } = useTreasury();
    const isMobile = useMediaQuery("(max-width: 768px)");
    const address = form.watch("address");
    const amount = form.watch("amount");

    const handleSave = async () => {
        // Validate and proceed to next step
        const isValid = await form.trigger();
        if (!isValid || !handleNext) return;

        if (ensureQuoteBeforeReview) {
            const hasQuote = await ensureQuoteBeforeReview();
            if (!hasQuote) return;
        }

        handleNext();
    };

    const isFormFilled = !!amount && Number(amount) > 0 && !!address;
    const saveButtonText = paymentsSlotBlocked
        ? tCreate("brieflyUnavailable")
        : hasRestrictedRecipientError
          ? tPay("useDifferentAddress")
          : isFormFilled
            ? tPay("reviewButton")
            : tPay("reviewButtonDisabled");

    return (
        <>
            <SlotWarning slot="payments" />
            <PageCard>
                <div className="flex justify-between items-center">
                    <StepperHeader
                        title={
                            isConfidential ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <span>{tPay("title")}</span>
                                    <Tooltip
                                        content={tPay("confidentialTooltip")}
                                    >
                                        <span className="inline-flex">
                                            <Shield className="size-4 fill-foreground" />
                                        </span>
                                    </Tooltip>
                                </span>
                            ) : (
                                tPay("title")
                            )
                        }
                    />
                    <div className="flex items-center gap-2">
                        {/* Bulk payments are available for confidential
                            treasuries too: the bulk-payment page guides
                            through one-time activation when the confidential
                            bulk access key isn't registered yet. */}
                        <Link href={`/${treasuryId}/payments/bulk-payment`}>
                            <Button
                                variant="ghost"
                                size={isMobile ? "icon" : "default"}
                                className="flex items-center gap-2 border-2"
                                id="payments-bulk-btn"
                                onClick={() => {
                                    trackEvent("bulk-payments-click", {
                                        source: "payments_page",
                                        treasury_id: treasuryId ?? "",
                                    });
                                }}
                            >
                                <ArrowDownToLine className="w-4 h-4" />
                                <span className="hidden md:block">
                                    {tPay("bulkPayments")}
                                </span>
                            </Button>
                        </Link>
                        <PendingButton
                            id="payments-pending-btn"
                            types={["Payments"]}
                        />
                    </div>
                </div>

                <PaymentFormSection
                    control={form.control}
                    amountName="amount"
                    tokenName="token"
                    recipientName="address"
                    destinationNetworkName="destinationNetwork"
                    destinationNetworkNameFieldName="destinationNetworkName"
                    feeErrorMessage={feeErrorMessage || quoteErrorMessage}
                    showRestrictedRecipientAlert={!!hasRestrictedRecipientError}
                    saveButtonText={saveButtonText}
                    slotBlocked={paymentsSlotBlocked}
                    onSave={handleSave}
                    isSubmitting={isFeeLoading}
                    onAddressBookSelectionChange={onAddressBookSelectionChange}
                    bridgeAssets={bridgeAssets}
                    isBridgeAssetsLoading={isBridgeAssetsLoading}
                    sendWarningMessage={sendWarningMessage}
                    recipientNetworkWarningMessage={
                        recipientNetworkWarningMessage
                    }
                />
            </PageCard>
        </>
    );
}

interface Step2Props extends StepProps {
    liveQuote?: IntentsQuoteResponse | null;
    isLoadingLiveQuote?: boolean;
    isFetchingLiveQuote?: boolean;
    isViaIntents?: boolean;
    bridgeAssets?: BridgeAsset[];
}

function Step2({
    handleBack,
    liveQuote,
    isLoadingLiveQuote,
    isFetchingLiveQuote,
    isViaIntents,
    bridgeAssets = [],
}: Step2Props) {
    const tPay = useTranslations("payments");
    const tIntents = useTranslations("intentsQuote");
    const form = useFormContext<PaymentFormValues>();
    const [token, amount, address, destinationNetwork] = useWatch({
        control: form.control,
        name: ["token", "amount", "address", "destinationNetwork"],
    }) as [PaymentFormValues["token"], string, string, string];
    const { data: tokenData } = useToken(token.address);
    // Chain icons for the destination network (for the review token icon overlay)
    const destinationChainIcons = useMemo(() => {
        if (!destinationNetwork) {
            return undefined;
        }
        if (isNearComNetwork(destinationNetwork)) {
            return getNearComChainIcons();
        }
        for (const asset of bridgeAssets) {
            const network = asset.networks.find(
                (n) => n.id === destinationNetwork,
            );
            if (network?.chainIcons) return network.chainIcons;
        }
        return undefined;
    }, [bridgeAssets, destinationNetwork]);
    const { data: addressBook = [] } = useAddressBook();
    const contactName = addressBook.find(
        (e) => e.address.toLowerCase() === address?.toLowerCase(),
    )?.name;

    const {
        totalAmountWithFees,
        recipientAmount,
        displayNetworkFee,
        estimatedUSDValue,
        recipientEstimatedUSDValue,
    } = useMemo(() => {
        const enteredAmount = Big(amount || "0");
        const price = tokenData?.price ?? 0;

        if (liveQuote?.quote) {
            const divisor = Big(10).pow(token.decimals);
            const quotedTotal = Big(
                liveQuote.quote.amountInFormatted ||
                    Big(liveQuote.quote.minAmountIn || "0")
                        .div(divisor)
                        .toString(),
            );
            const quotedRecipient = Big(
                liveQuote.quote.amountOutFormatted ||
                    Big(liveQuote.quote.minAmountOut || "0")
                        .div(divisor)
                        .toString(),
            );
            const feeValue = Big(
                (computeQuoteNetworkFee(liveQuote.quote) || "0").replaceAll(
                    ",",
                    "",
                ),
            );

            return {
                totalAmountWithFees: quotedTotal,
                recipientAmount: quotedRecipient,
                displayNetworkFee: feeValue,
                estimatedUSDValue: price ? quotedTotal.mul(price) : Big(0),
                recipientEstimatedUSDValue: price
                    ? quotedRecipient.mul(price)
                    : Big(0),
            };
        }

        return {
            totalAmountWithFees: enteredAmount,
            recipientAmount: enteredAmount,
            displayNetworkFee: Big(0),
            estimatedUSDValue: price ? enteredAmount.mul(price) : Big(0),
            recipientEstimatedUSDValue: price
                ? enteredAmount.mul(price)
                : Big(0),
        };
    }, [amount, liveQuote, token.decimals, tokenData?.price]);

    const isQuoteLoading =
        isViaIntents && (isLoadingLiveQuote || isFetchingLiveQuote);

    return (
        <PageCard>
            <ReviewStep
                reviewingTitle={tPay("reviewYourPayment")}
                handleBack={handleBack}
            >
                <AmountSummary
                    total={totalAmountWithFees}
                    totalUSD={estimatedUSDValue.toNumber()}
                    token={token}
                    showNetworkIcon={true}
                    preserveFormattedTotal={!!liveQuote?.quote}
                >
                    <p>{tPay("summaryRecipients", { count: 1 })}</p>
                </AmountSummary>
                <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-1 w-full">
                        <div className="flex justify-between items-center gap-2 w-full text-xs">
                            <div className="flex flex-col gap-0.5 min-w-0">
                                {contactName && (
                                    <p className="font-semibold">
                                        {contactName}
                                    </p>
                                )}
                                <Address
                                    address={address}
                                    className={cn(
                                        contactName
                                            ? "text-muted-foreground"
                                            : "font-semibold",
                                    )}
                                />
                            </div>
                            <div className="flex items-center gap-5 min-w-fit">
                                <TokenDisplay
                                    icon={token.icon}
                                    symbol={token.symbol}
                                    chainIcons={
                                        destinationChainIcons ??
                                        token.chainIcons ??
                                        undefined
                                    }
                                />
                                <div className="flex flex-col gap-[3px] items-end">
                                    <p className="text-xs font-semibold text-wrap break-all">
                                        {formatTokenDisplayAmount(
                                            recipientAmount,
                                        )}{" "}
                                        {token.symbol}
                                    </p>
                                    <p className="text-xxs text-muted-foreground text-wrap break-all">
                                        ≈{" "}
                                        {formatCurrency(
                                            recipientEstimatedUSDValue,
                                        )}
                                    </p>
                                </div>
                            </div>
                        </div>
                        {isViaIntents && displayNetworkFee.gt(0) && (
                            <div className="flex items-center justify-between gap-2 text-sm my-3">
                                <div className="flex items-center gap-1 text-muted-foreground">
                                    <p>{tPay("networkFee")}</p>
                                    <Tooltip
                                        content={tIntents("networkFeeTooltip")}
                                        side="top"
                                    >
                                        <Info
                                            className="size-3 shrink-0"
                                            aria-label={tPay("networkFeeInfo")}
                                        />
                                    </Tooltip>
                                </div>
                                <p>
                                    {formatTokenDisplayAmount(
                                        displayNetworkFee,
                                    )}{" "}
                                    {token.symbol}
                                </p>
                            </div>
                        )}
                        <FormField
                            control={form.control}
                            name="memo"
                            render={({ field }) => (
                                <Textarea
                                    value={field.value}
                                    onChange={field.onChange}
                                    borderless
                                    rows={2}
                                    placeholder={tPay("commentPlaceholder")}
                                />
                            )}
                        />
                    </div>
                </div>
            </ReviewStep>

            <div className="rounded-lg border bg-card p-0 overflow-hidden">
                <CreateRequestButton
                    isSubmitting={form.formState.isSubmitting || isQuoteLoading}
                    type="submit"
                    className="w-full h-10 rounded-none"
                    permissions={[
                        { kind: "transfer", action: "AddProposal" },
                        { kind: "call", action: "AddProposal" },
                    ]}
                    idleMessage={
                        isQuoteLoading
                            ? tPay("preparingRoute")
                            : tPay("confirmSubmit")
                    }
                    disabled={isQuoteLoading}
                />
            </div>
        </PageCard>
    );
}

type PaymentFormValues = z.infer<ReturnType<typeof buildPaymentFormSchema>>;

type PaymentTokenClassification = {
    isNearNativeToken: boolean;
    isNearFtToken: boolean;
    isNearComRoute: boolean;
    intentsOriginAsset: string;
    tokenForIntentsQuote: Token;
};

// 1Click expects `amount` in destination-asset base units for EXACT_OUTPUT.
// Some routes have mixed token decimals across networks (e.g. 18 vs 24), so
// we resolve decimals from the selected destination network to avoid
// under/over-scaling the quote request amount.
function getDestinationAmountDecimals(
    token: Token,
    destinationNetwork: string | undefined,
    bridgeAssets: BridgeAsset[],
): number | undefined {
    if (!destinationNetwork || isNearComNetwork(destinationNetwork)) {
        return token.decimals;
    }

    const bridgeAsset = findBridgeAssetForToken(bridgeAssets, token);
    const destination = bridgeAsset?.networks.find(
        (network) => network.id === destinationNetwork,
    );

    return destination?.decimals;
}

function classifyPaymentToken(
    token: Token,
    destinationNetwork?: string,
): PaymentTokenClassification {
    const isNearNativeToken = isNearChainNativeToken(token);
    const isNearFtToken = isNearChainFtToken(token);
    const isNearComRoute = isNearComNetwork(destinationNetwork);
    const intentsOriginAsset = isNearNativeToken
        ? "nep141:wrap.near"
        : isNearFtToken
          ? `nep141:${token.address}`
          : token.address;

    return {
        isNearNativeToken,
        isNearFtToken,
        isNearComRoute,
        intentsOriginAsset,
        tokenForIntentsQuote:
            intentsOriginAsset === token.address
                ? token
                : { ...token, address: intentsOriginAsset },
    };
}

const STABLE_TOKEN_PRIORITY: Record<string, number> = {
    USDC: 2,
    USDT: 1,
};

function getNetworkMatchScore(
    tokenNetwork: string,
    preferredNetworks: string[],
): number {
    const normalizedTokenNetwork = tokenNetwork.trim().toLowerCase();
    const tokenBlockchain = getBlockchainType(normalizedTokenNetwork);
    let bestScore = 0;

    preferredNetworks.forEach((preferredNetwork, index) => {
        const normalizedPreferredNetwork = preferredNetwork
            .trim()
            .toLowerCase();

        if (normalizedPreferredNetwork === normalizedTokenNetwork) {
            bestScore = Math.max(bestScore, 200 - index);
            return;
        }

        const preferredBlockchain = getBlockchainType(
            normalizedPreferredNetwork,
        );

        if (
            preferredBlockchain !== "unknown" &&
            preferredBlockchain === tokenBlockchain
        ) {
            bestScore = Math.max(bestScore, 100 - index);
        }
    });

    return bestScore;
}

function pickCompatibleFallbackToken(
    preferredNetworks: string[],
    bridgeAssets: BridgeAsset[],
): Token | null {
    let bestCandidate: { score: number; token: Token } | null = null;

    for (const asset of bridgeAssets) {
        for (const network of asset.networks) {
            const networkScore = getNetworkMatchScore(
                network.name,
                preferredNetworks,
            );

            if (networkScore === 0) {
                continue;
            }

            const stablePriority =
                STABLE_TOKEN_PRIORITY[network.symbol.toUpperCase()] ?? 0;
            const candidateScore = networkScore * 10 + stablePriority;
            const candidate: Token = {
                address: network.id,
                symbol: network.symbol,
                decimals: network.decimals,
                name: asset.name,
                icon: asset.icon,
                network: network.name,
                chainIcons: network.chainIcons ?? undefined,
                residency: "Intents",
                minWithdrawalAmount: network.minWithdrawalAmount,
                minDepositAmount: network.minDepositAmount,
            };

            if (!bestCandidate || candidateScore > bestCandidate.score) {
                bestCandidate = {
                    score: candidateScore,
                    token: candidate,
                };
            }
        }
    }

    return bestCandidate?.token ?? null;
}

function buildIntentTransferDescription(
    data: PaymentFormValues,
    quote: Awaited<ReturnType<typeof getIntentsQuote>>,
): string {
    const notes = [data.memo?.trim()].filter(Boolean).join(" ");
    const networkFee = computeQuoteNetworkFee(quote?.quote);

    return encodeToMarkdown({
        proposal_action: "payment-transfer",
        notes,
        recipient: data.address,
        destinationNetwork: data.destinationNetwork || undefined,
        networkFee,
        depositAddress: quote?.quote.depositAddress,
        signature: quote?.signature,
    });
}

function buildQuoteContextKey(params: {
    tokenAddress: string;
    amount: string;
    address: string;
    destinationNetwork?: string;
}) {
    return [
        params.tokenAddress,
        params.amount.trim(),
        params.address.trim().toLowerCase(),
        params.destinationNetwork ?? "",
    ].join("|");
}

type CachedQuote = {
    key: string;
    quote: IntentsQuoteResponse;
};

export default function PaymentsPage() {
    const t = useTranslations("pages.payments");
    const tPay = useTranslations("payments");
    const tValidation = useTranslations("paymentForm.validation");
    const paymentFormSchema = useMemo(
        () =>
            buildPaymentFormSchema({
                recipientMin: tValidation("recipientMin"),
                recipientMax: tValidation("recipientMax"),
                amountGreaterThanZero: tValidation("amountGreaterThanZero"),
                recipientSameAsToken: tValidation("recipientSameAsToken"),
            }),
        [tValidation],
    );
    const { treasuryId, isConfidential } = useTreasury();
    const pageTitle = isConfidential ? t("confidentialTitle") : t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [step, setStep] = useState(0);
    const searchParams = useSearchParams();
    const autoSelectedTokenKeyRef = useRef<string | null>(null);
    // Cached quote + context key — avoids re-fetching while preventing stale reuse.
    const cachedQuoteRef = useRef<CachedQuote | null>(null);
    const [isAddressBookRecipientSelected, setIsAddressBookRecipientSelected] =
        useState(false);

    const tokenParam = searchParams.get("token");
    const preferredNetworks = useMemo(
        () =>
            (searchParams.get("networks") ?? searchParams.get("network") ?? "")
                .split(",")
                .map((network) => network.trim())
                .filter(Boolean),
        [searchParams],
    );
    const autoSelectionKey = useMemo(
        () => preferredNetworks.join(","),
        [preferredNetworks],
    );
    const {
        data: bridgeAssets = [],
        isLoading: isBridgeAssetsLoading,
        isFetching: isBridgeAssetsFetching,
    } = useBridgeTokens(true);

    const defaultToken = useMemo(() => {
        const fallbackToken = default_near_token(isConfidential);
        return parseTokenQueryParam(tokenParam, fallbackToken);
    }, [tokenParam, isConfidential]);

    const compatibleDefaultToken = useMemo(() => {
        if (tokenParam || preferredNetworks.length === 0) {
            return null;
        }

        return pickCompatibleFallbackToken(preferredNetworks, bridgeAssets);
    }, [bridgeAssets, preferredNetworks, tokenParam]);

    const preferredBlockchainTypes = useMemo(() => {
        const set = new Set<string>();
        for (const network of preferredNetworks) {
            const type = getBlockchainType(network);
            if (type !== "unknown") set.add(type);
        }
        return set;
    }, [preferredNetworks]);

    const defaultAddress = useMemo(() => {
        const addressParam = searchParams.get("address");
        return addressParam ? decodeURIComponent(addressParam) : "";
    }, [searchParams]);

    // Onboarding tours
    usePageTour(
        PAGE_TOUR_NAMES.PAYMENTS_BULK,
        PAGE_TOUR_STORAGE_KEYS.PAYMENTS_BULK_SHOWN,
        {
            enabled: !isConfidential,
        },
    );
    const { triggerTour: triggerPendingTour } = useManualPageTour(
        PAGE_TOUR_NAMES.PAYMENTS_PENDING,
        PAGE_TOUR_STORAGE_KEYS.PAYMENTS_PENDING_SHOWN,
    );

    const form = useForm<PaymentFormValues>({
        resolver: zodResolver(paymentFormSchema),
        defaultValues: {
            address: "",
            amount: "",
            memo: "",
            token: defaultToken,
            destinationNetwork: "",
            destinationNetworkName: "",
        },
    });
    const [
        watchedToken,
        watchedAmount,
        watchedAddress,
        watchedDestinationNetwork,
        watchedDestinationNetworkName,
    ] = useWatch({
        control: form.control,
        name: [
            "token",
            "amount",
            "address",
            "destinationNetwork",
            "destinationNetworkName",
        ],
    }) as [PaymentFormValues["token"], string, string, string, string];

    const {
        blocked: paymentsSlotBlocked,
        message: sendScopeMessage,
        scopedMessage: sendWarningMessage,
        scope: paymentsScope,
    } = useBridgeScopedWarning("payments", bridgeAssets, watchedToken?.address);
    const {
        warning: recipientNetworkScopeWarning,
        message: recipientNetworkScopeMessage,
    } = useScopedSlotWarning(
        "payments",
        paymentsScope.token ?? undefined,
        watchedDestinationNetworkName || undefined,
    );
    const recipientNetworkWarningMessage = watchedDestinationNetwork
        ? scopedFieldMessage(
              recipientNetworkScopeWarning,
              recipientNetworkScopeMessage,
          )
        : null;

    const watchedTokenClassification = useMemo(
        () => classifyPaymentToken(watchedToken, watchedDestinationNetwork),
        [watchedToken, watchedDestinationNetwork],
    );
    const isWatchedNearNativeToken =
        watchedTokenClassification.isNearNativeToken;
    const isWatchedNearFtToken = watchedTokenClassification.isNearFtToken;

    const normalizedWatchedAddress = watchedAddress.trim().toLowerCase();
    const isWatchedEthImplicit = isEthImplicitNearAddress(
        normalizedWatchedAddress,
    );
    const isWatchedNearRecipient =
        isValidNearAddressFormat(normalizedWatchedAddress) &&
        !isWatchedEthImplicit;
    const isWatchedNearComRoute = watchedTokenClassification.isNearComRoute;

    // True when we'll send via a direct Transfer (not through Intents).
    const isWatchedDirectTransfer =
        !isConfidential &&
        !isWatchedNearComRoute &&
        isWatchedNearRecipient &&
        (isWatchedNearNativeToken || isWatchedNearFtToken);

    // Token object to use for the 1Click quote. For native NEAR and NEAR FT we
    // swap in the nep141: prefix so the hook enables and shows a fee preview.
    const quoteToken = useMemo((): Token => {
        if (isConfidential || isWatchedDirectTransfer) return watchedToken;
        return watchedTokenClassification.tokenForIntentsQuote;
    }, [
        watchedToken,
        isConfidential,
        isWatchedDirectTransfer,
        watchedTokenClassification,
    ]);

    // Whether this payment will go through the Intents protocol.
    const isViaIntents = isIntentsToken(quoteToken);
    const quoteContextKey = useMemo(
        () =>
            buildQuoteContextKey({
                tokenAddress: quoteToken.address,
                amount: watchedAmount ?? "",
                address: watchedAddress ?? "",
                destinationNetwork: watchedDestinationNetwork,
            }),
        [
            quoteToken.address,
            watchedAmount,
            watchedAddress,
            watchedDestinationNetwork,
        ],
    );

    const destinationAmountDecimals = useMemo(
        () =>
            getDestinationAmountDecimals(
                quoteToken,
                watchedDestinationNetwork,
                bridgeAssets,
            ),
        [bridgeAssets, quoteToken, watchedDestinationNetwork],
    );

    // ── Live quote (drives step-1 fee preview & step-2 review) ───────────────

    const {
        quote: liveQuote,
        isLoading: isLoadingLiveQuote,
        isFetching: isFetchingLiveQuote,
        isEnsuring: isEnsuringQuote,
        isSyncPending: isQuoteSyncPending,
        hasError: hasLiveQuoteError,
        errorMessage: liveQuoteErrorMessage,
        hasInvalidRecipientAddressError,
        ensureBeforeReview,
    } = useIntentsQuote({
        treasuryId,
        token: quoteToken,
        amount: watchedAmount,
        destinationAmountDecimals,
        address: watchedAddress,
        isConfidential,
        proposalPeriod: policy?.proposal_period,
        destinationNetwork: watchedDestinationNetwork,
        isPayment: true,
        // Paused payment (critical warning on token/network or app-wide): don't
        // fetch the quote.
        enabled: !paymentsSlotBlocked,
    });

    const paymentNetworkFee = useMemo(() => {
        if (!liveQuote?.quote) return null;
        const fee = computeQuoteNetworkFee(liveQuote.quote);
        return fee ? fee.replaceAll(",", "") : null;
    }, [liveQuote]);

    // Keep the quote ref in sync so onSubmit can use it without re-fetching.
    useEffect(() => {
        cachedQuoteRef.current = liveQuote
            ? { key: quoteContextKey, quote: liveQuote }
            : null;
    }, [liveQuote, quoteContextKey]);

    // Invalidate cached quote whenever core quote inputs change so review never
    // shows stale data from a previous token/address/network combination.
    useEffect(() => {
        cachedQuoteRef.current = null;
    }, [
        watchedToken.address,
        watchedAmount,
        watchedAddress,
        watchedDestinationNetwork,
    ]);

    // Clear stale quote-related manual errors as soon as the user changes any
    // quote-driving input. Fresh validation/quote errors will be re-applied by
    // the live quote flow if still relevant.
    useEffect(() => {
        const amountError = form.getFieldState("amount").error;
        if (amountError?.type !== "manual") return;
        form.clearErrors("amount");
    }, [
        form,
        watchedToken.address,
        watchedAmount,
        watchedAddress,
        watchedDestinationNetwork,
    ]);

    const isQuoteBusy =
        isViaIntents &&
        (isLoadingLiveQuote ||
            isFetchingLiveQuote ||
            isEnsuringQuote ||
            isQuoteSyncPending);

    // ── Destination network auto-wiring ───────────────────────────────────────

    const compatibleDestination = useMemo(() => {
        if (
            preferredBlockchainTypes.size === 0 ||
            !watchedToken ||
            bridgeAssets.length === 0
        ) {
            return null;
        }

        const bridgeAsset = findBridgeAssetForToken(bridgeAssets, watchedToken);
        if (!bridgeAsset) return null;

        const matches = bridgeAsset.networks.filter((network) =>
            preferredBlockchainTypes.has(getBlockchainType(network.name)),
        );
        if (matches.length !== 1) return null;

        return {
            id: matches[0].id,
            networkName: matches[0].name,
        };
    }, [bridgeAssets, preferredBlockchainTypes, watchedToken]);

    // ── Ensure quote is fresh before entering the review step ─────────────────

    const ensureQuoteBeforeReview = useCallback(async (): Promise<boolean> => {
        const formValues = form.getValues();
        const ensureRequestKey = buildQuoteContextKey({
            tokenAddress: quoteToken.address,
            amount: formValues.amount ?? "",
            address: formValues.address ?? "",
            destinationNetwork: formValues.destinationNetwork,
        });
        const result = await ensureBeforeReview({
            token: quoteToken,
            address: formValues.address,
            amount: formValues.amount,
        });
        if (result.ok) {
            if (result.quote) {
                cachedQuoteRef.current = {
                    key: ensureRequestKey,
                    quote: result.quote,
                };
            }
            form.clearErrors("amount");
            return true;
        }
        if (result.error) {
            if (result.error.includes("initializing")) {
                toast.error(result.error);
            } else {
                form.setError("amount", {
                    type: "manual",
                    message: result.error,
                });
            }
        }
        return false;
    }, [ensureBeforeReview, form, quoteToken]);

    // ── Effects ───────────────────────────────────────────────────────────────

    useEffect(() => {
        form.setValue("token", defaultToken);
    }, [defaultToken, form]);

    useEffect(() => {
        if (!compatibleDestination) return;
        if (watchedDestinationNetwork) return;
        const timeoutId = window.setTimeout(() => {
            form.setValue("destinationNetwork", compatibleDestination.id, {
                shouldDirty: true,
            });
            form.setValue(
                "destinationNetworkName",
                compatibleDestination.networkName,
                { shouldDirty: true },
            );
        }, 150);
        return () => window.clearTimeout(timeoutId);
    }, [compatibleDestination, form, watchedDestinationNetwork]);

    useEffect(() => {
        if (!defaultAddress) return;
        if (!watchedDestinationNetwork) return;
        if (form.getValues("address") === defaultAddress) return;
        form.setValue("address", defaultAddress, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
        });
    }, [defaultAddress, watchedDestinationNetwork, form]);

    useEffect(() => {
        if (!compatibleDefaultToken || tokenParam) {
            return;
        }

        const currentToken = form.getValues("token");
        const defaultNearToken = default_near_token(isConfidential);
        const isStillDefaultNearToken =
            currentToken?.address === defaultNearToken.address &&
            currentToken?.network === defaultNearToken.network;

        if (
            !isStillDefaultNearToken ||
            autoSelectedTokenKeyRef.current === autoSelectionKey
        ) {
            return;
        }

        form.setValue("token", compatibleDefaultToken);
        autoSelectedTokenKeyRef.current = autoSelectionKey;
    }, [autoSelectionKey, compatibleDefaultToken, form, tokenParam]);

    // ── Submit ────────────────────────────────────────────────────────────────

    const onSubmit = async (data: PaymentFormValues) => {
        if (paymentsSlotBlocked) {
            if (sendScopeMessage) toast.error(sendScopeMessage);
            return;
        }

        try {
            const proposalBond = policy?.proposal_bond || "0";
            const trimmedAddress = data.address.trim();
            const normalizedNearAddress = trimmedAddress.toLowerCase();
            const tokenClassification = classifyPaymentToken(
                data.token,
                data.destinationNetwork,
            );
            const { isNearNativeToken, isNearFtToken, isNearComRoute } =
                tokenClassification;

            const isEthImplicit = isEthImplicitNearAddress(
                normalizedNearAddress,
            );
            const isNearRecipient =
                isValidNearAddressFormat(normalizedNearAddress) &&
                !isEthImplicit;

            const shouldUseDirectTransfer =
                !isConfidential &&
                !isNearComRoute &&
                isNearRecipient &&
                (isNearNativeToken || isNearFtToken);

            const shouldUseIntents = isConfidential
                ? isIntentsToken(data.token)
                : !shouldUseDirectTransfer;

            const directTransferAmount = Big(data.amount)
                .mul(Big(10).pow(data.token.decimals))
                .toFixed();

            let description = encodeToMarkdown({ notes: data.memo || "" });
            let proposalKind: FunctionCallKind | TransferKind;

            if (shouldUseIntents) {
                const quoteAmountDecimals = getDestinationAmountDecimals(
                    tokenClassification.tokenForIntentsQuote,
                    data.destinationNetwork,
                    bridgeAssets,
                );
                if (quoteAmountDecimals === undefined) {
                    throw new Error(tPay("failed1ClickQuote"));
                }
                const quoteAmount = Big(data.amount)
                    .mul(Big(10).pow(quoteAmountDecimals))
                    .toFixed();
                const tokenForQuote = tokenClassification.tokenForIntentsQuote;

                // Use the cached quote from the live hook; fall back to a
                // fresh fetch if the cache is empty (e.g. first load).
                const submitQuoteKey = buildQuoteContextKey({
                    tokenAddress: tokenForQuote.address,
                    amount: data.amount ?? "",
                    address: trimmedAddress,
                    destinationNetwork: data.destinationNetwork,
                });
                const cachedQuote =
                    cachedQuoteRef.current?.key === submitQuoteKey
                        ? cachedQuoteRef.current.quote
                        : null;
                const quote =
                    cachedQuote ??
                    (await getIntentsQuote(
                        buildIntentsQuoteRequest(
                            treasuryId!,
                            tokenForQuote,
                            trimmedAddress,
                            quoteAmount,
                            isConfidential,
                            policy?.proposal_period,
                            undefined,
                            data.destinationNetwork,
                            true, // isPayment
                        ),
                        false,
                    ));

                if (!quote) {
                    throw new Error(tPay("failed1ClickQuote"));
                }

                if (isConfidential) {
                    // Confidential path: generate intent + build v1.signer proposal
                    // Pass the full quote (minus correlationId, already stored separately)
                    // so the backend can persist it for displaying proposal details.
                    const { correlationId: _, ...quoteMetadata } =
                        quote as unknown as Record<string, unknown>;
                    const intentResponse = await generateIntent({
                        type: "swap_transfer",
                        standard: "nep413",
                        signerId: treasuryId!,
                        quoteMetadata,
                        notes: data.memo?.trim() || undefined,
                    });

                    const confidentialResult = await buildConfidentialProposal({
                        intentResponse,
                        treasuryId: treasuryId!,
                    });

                    description = confidentialResult.proposal.description;
                    proposalKind = confidentialResult.proposal
                        .kind as FunctionCallKind;
                } else {
                    description = buildIntentTransferDescription(data, quote);
                    const { depositAddress, amountIn } = quote.quote;

                    if (isIntentsToken(data.token)) {
                        proposalKind = buildIntentsTransferProposal(
                            data.token.address,
                            depositAddress,
                            amountIn,
                        );
                    } else if (isNearNativeToken) {
                        proposalKind = buildNativeNearIntentsKind(
                            depositAddress,
                            amountIn,
                        );
                    } else {
                        proposalKind = buildNearFtIntentsKind(
                            data.token.address,
                            depositAddress,
                            amountIn,
                        );
                    }
                }
            } else {
                // Direct NEAR or NEAR FT transfer
                proposalKind = buildDirectTransferKind(
                    trimmedAddress,
                    data.token,
                    directTransferAmount,
                    isConfidential,
                );
            }

            await createProposal(tPay("paymentSubmitted"), {
                treasuryId: treasuryId!,
                proposal: {
                    description,
                    kind: proposalKind!,
                },
                proposalBond,
                proposalType: "payment",
                addressBookPayment: isAddressBookRecipientSelected,
            })
                .then(() => {
                    trackEvent("payment-submitted", {
                        treasury_id: treasuryId ?? "",
                        token_symbol: data.token.symbol,
                        amount: data.amount,
                    });
                    form.reset();
                    cachedQuoteRef.current = null;
                    setIsAddressBookRecipientSelected(false);
                    setStep(0);
                    triggerPendingTour();
                })
                .catch((error) => {
                    console.error("Payments error", error);
                });
        } catch (error) {
            console.error("Payments error", error);
        }
    };

    // ── Step configuration ────────────────────────────────────────────────────

    const steps = useMemo(
        () => [
            {
                component: Step1,
                props: {
                    networkFee: paymentNetworkFee,
                    isFeeLoading: isQuoteBusy,
                    quoteErrorMessage:
                        isViaIntents && hasLiveQuoteError
                            ? liveQuoteErrorMessage
                            : null,
                    hasRestrictedRecipientError:
                        isViaIntents &&
                        hasLiveQuoteError &&
                        hasInvalidRecipientAddressError,
                    ensureQuoteBeforeReview,
                    onAddressBookSelectionChange:
                        setIsAddressBookRecipientSelected,
                    bridgeAssets,
                    isBridgeAssetsLoading:
                        isBridgeAssetsLoading || isBridgeAssetsFetching,
                    paymentsSlotBlocked,
                    sendWarningMessage,
                    recipientNetworkWarningMessage,
                },
            },
            {
                component: Step2,
                props: {
                    liveQuote:
                        liveQuote ??
                        (cachedQuoteRef.current?.key === quoteContextKey
                            ? cachedQuoteRef.current.quote
                            : null),
                    isLoadingLiveQuote,
                    isFetchingLiveQuote,
                    isViaIntents,
                    bridgeAssets,
                },
            },
        ],
        [
            isQuoteBusy,
            isViaIntents,
            hasLiveQuoteError,
            liveQuoteErrorMessage,
            hasInvalidRecipientAddressError,
            ensureQuoteBeforeReview,
            paymentNetworkFee,
            liveQuote,
            isLoadingLiveQuote,
            isFetchingLiveQuote,
            bridgeAssets,
            isBridgeAssetsLoading,
            isBridgeAssetsFetching,
            paymentsSlotBlocked,
            sendWarningMessage,
            recipientNetworkWarningMessage,
            quoteContextKey,
        ],
    );

    return (
        <PageComponentLayout title={pageTitle} description={t("description")}>
            <Form {...form}>
                <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="flex flex-col gap-4 max-w-[600px] mx-auto"
                >
                    <StepWizard
                        step={step}
                        onStepChange={setStep}
                        steps={steps}
                    />
                </form>
            </Form>
        </PageComponentLayout>
    );
}
