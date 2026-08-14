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
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { default_near_token, default_usdc_near_token } from "@/constants/token";
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
import {
    hasNearComAddressPrefix,
    stripNearComAddressPrefix,
} from "@/lib/nearcom-address";
import { useNear } from "@/stores/near-store";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
import { PaymentFormSection } from "./components/payment-form-section";
import { Address } from "@/components/address";
import {
    useIntentsQuote,
    buildIntentsQuoteRequest,
    type IntentsAmountMode,
} from "@/hooks/use-intents-quote";
import { getNearComChainIcons, isNearComNetwork } from "@/lib/intents-network";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import {
    cn,
    encodeToMarkdown,
    formatCurrency,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { findBridgeAssetForToken } from "@/lib/bridge-asset-resolver";
import {
    computeQuoteNetworkFee,
    isIntentsCrossChainToken,
    isIntentsToken,
    isNearChainFtToken,
    isNearChainNativeToken,
} from "@/lib/intents-fee";
import { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import {
    isBareNearContractId,
    isIntentsNetworkId,
    isJsonTokenQueryParam,
    isNativeNearPrefill as resolveIsNativeNearPrefill,
    nearChainDestination,
    normalizePreferredNetwork,
    parseSoftNetworks,
    pickCompatibleFallbackToken,
    resolveExactBridgeToken,
    resolvePreferredDestinationNetwork,
    resolvePreferredNetworks,
} from "./utils/payments-deep-link";
import { buildDirectTransferKind } from "./utils/proposal-builder";

function buildPaymentFormSchema(messages: {
    recipientMin: string;
    recipientMax: string;
    amountGreaterThanZero: string;
    recipientSameAsToken: string;
    selectToken: string;
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
            // Null while assets load before seeding the default token.
            token: tokenSchema.nullable(),
        })
        .superRefine((data, ctx) => {
            if (!data.token) {
                ctx.addIssue({
                    code: "custom",
                    path: ["token"],
                    message: messages.selectToken,
                });
                return;
            }
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
    onAmountInput?: () => void;
    onMaxSet?: (maxAmount: string) => void;
    onAddressBookSelectionChange?: (isFromAddressBook: boolean) => void;
    bridgeAssets?: BridgeAsset[];
    isBridgeAssetsLoading?: boolean;
    paymentsSlotBlocked?: boolean;
    sendWarningMessage?: string | null;
    recipientNetworkWarningMessage?: string | null;
    /** False when the page seeds token from ?token= / ?networks=. */
    tokenAutoSelect?: boolean;
}

function Step1({
    handleNext,
    feeErrorMessage,
    networkFee,
    isFeeLoading,
    quoteErrorMessage,
    hasRestrictedRecipientError,
    ensureQuoteBeforeReview,
    onAmountInput,
    onMaxSet,
    onAddressBookSelectionChange,
    bridgeAssets = [],
    isBridgeAssetsLoading = false,
    paymentsSlotBlocked = false,
    sendWarningMessage = null,
    recipientNetworkWarningMessage = null,
    tokenAutoSelect = true,
}: Step1Props) {
    const tPay = useTranslations("payments");
    const tCreate = useTranslations("createRequestButton");
    const form = useFormContext<PaymentFormValues>();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const isMobile = useMediaQuery("(max-width: 768px)");
    const address = form.watch("address");
    const amount = form.watch("amount");
    const showConfidentialShield = isConfidential && !isGuestTreasury;

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
                            showConfidentialShield ? (
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
                    networkFee={networkFee}
                    showRestrictedRecipientAlert={!!hasRestrictedRecipientError}
                    saveButtonText={saveButtonText}
                    slotBlocked={paymentsSlotBlocked}
                    onSave={handleSave}
                    isSubmitting={isFeeLoading}
                    onAmountInput={onAmountInput}
                    onMaxSet={onMaxSet}
                    onAddressBookSelectionChange={onAddressBookSelectionChange}
                    bridgeAssets={bridgeAssets}
                    isBridgeAssetsLoading={isBridgeAssetsLoading}
                    sendWarningMessage={sendWarningMessage}
                    recipientNetworkWarningMessage={
                        recipientNetworkWarningMessage
                    }
                    tokenAutoSelect={tokenAutoSelect}
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
    const { data: tokenData } = useToken(token?.address);
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
        if (!token) {
            return {
                totalAmountWithFees: Big(0),
                recipientAmount: Big(0),
                displayNetworkFee: Big(0),
                estimatedUSDValue: Big(0),
                recipientEstimatedUSDValue: Big(0),
            };
        }

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
    }, [amount, liveQuote, token, tokenData?.price]);

    const isQuoteLoading =
        isViaIntents && (isLoadingLiveQuote || isFetchingLiveQuote);

    if (!token) return null;

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

/** Decimals for the quote `amount`: destination asset for EXACT_OUTPUT, origin for EXACT_INPUT. */
function getQuoteAmountDecimals(
    token: Token,
    destinationNetwork: string | undefined,
    amountMode: IntentsAmountMode,
    bridgeAssets: BridgeAsset[],
): number | undefined {
    // EXACT_INPUT (MAX) and near.com routes use the origin token's decimals.
    if (
        amountMode !== "recipient" ||
        !destinationNetwork ||
        isNearComNetwork(destinationNetwork)
    ) {
        return token.decimals;
    }

    const bridgeAsset = findBridgeAssetForToken(bridgeAssets, token);
    return bridgeAsset?.networks.find((n) => n.id === destinationNetwork)
        ?.decimals;
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
    amountMode: IntentsAmountMode;
}) {
    return [
        params.tokenAddress,
        params.amount.trim(),
        params.address.trim().toLowerCase(),
        params.destinationNetwork ?? "",
        params.amountMode,
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
                selectToken: tValidation("selectToken"),
            }),
        [tValidation],
    );
    const { treasuryId, isConfidential } = useTreasury();
    const pageTitle = isConfidential ? t("confidentialTitle") : t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [step, setStep] = useState(0);
    const searchParams = useSearchParams();
    // Cached quote + context key — avoids re-fetching while preventing stale reuse.
    const cachedQuoteRef = useRef<CachedQuote | null>(null);
    /** `"recipient"` = EXACT_OUTPUT (typed); `"total"` = EXACT_INPUT (MAX, fees included). */
    const [intentsAmountMode, setIntentsAmountMode] =
        useState<IntentsAmountMode>("recipient");
    const [isAddressBookRecipientSelected, setIsAddressBookRecipientSelected] =
        useState(false);

    const tokenParam = searchParams.get("token");
    // Hybrid deep links:
    // - exact Intents:     `?token=<assetId>&network=nep141:…` (or `eth:1:…`)
    // - exact Ft:          `?token=<assetId>&network=<bareContract>`
    // - exact native NEAR: `?token=NEAR&network=near`
    // - soft:              `?networks=eth,near` (+ optional `token=<assetId>`)
    const networkParam = searchParams.get("network");
    const networksParam = searchParams.get("networks");
    const softNetworks = useMemo(
        () => parseSoftNetworks(networksParam),
        [networksParam],
    );
    const isFtNetworkPrefill = !!(
        networkParam && isBareNearContractId(networkParam)
    );
    const isNativeNearPrefill = resolveIsNativeNearPrefill({
        tokenParam,
        networkParam,
    });
    const exactTokenNetworkId =
        !isNativeNearPrefill &&
        networkParam &&
        (isIntentsNetworkId(networkParam) || isFtNetworkPrefill)
            ? networkParam
            : null;
    const preferredNetworks = useMemo(
        () =>
            resolvePreferredNetworks({
                softNetworks,
                networkParam,
                isFtNetworkPrefill,
                isNativeNearPrefill,
            }),
        [softNetworks, networkParam, isFtNetworkPrefill, isNativeNearPrefill],
    );
    const {
        data: bridgeAssets = [],
        isLoading: isBridgeAssetsLoading,
        isFetching: isBridgeAssetsFetching,
    } = useBridgeTokens(true);
    // Generic default (highest-USD → USDC) lives in TokenSelect.autoSelect.
    // Page only seeds from URL overrides so the two don't fight.
    const namePreferredNetworks = useMemo(
        () =>
            preferredNetworks.filter((network) => !isIntentsNetworkId(network)),
        [preferredNetworks],
    );
    // Address-book links often list many chains — still pick a send token, but
    // leave destination empty so the user chooses among preferred networks.
    const hasAmbiguousSoftNetworks = namePreferredNetworks.length > 1;
    const plainTokenAssetId =
        tokenParam && !isJsonTokenQueryParam(tokenParam) ? tokenParam : null;
    const compatibleDefaultToken = useMemo(() => {
        if (isNativeNearPrefill) return null;
        if (namePreferredNetworks.length === 0) return null;
        return pickCompatibleFallbackToken(
            namePreferredNetworks,
            bridgeAssets,
            plainTokenAssetId,
        );
    }, [
        bridgeAssets,
        namePreferredNetworks,
        plainTokenAssetId,
        isNativeNearPrefill,
    ]);

    const urlOverrideToken = useMemo(() => {
        if (
            isBridgeAssetsLoading &&
            (tokenParam || preferredNetworks.length > 0)
        ) {
            return null;
        }

        // 1) Legacy assets-table JSON blob (read-only compat).
        if (tokenParam && isJsonTokenQueryParam(tokenParam)) {
            return parseTokenQueryParam(tokenParam, default_usdc_near_token());
        }

        // 2) Native NEAR (not intents wrap.near).
        if (isNativeNearPrefill) {
            return default_near_token(isConfidential);
        }

        // 3) Exact: prefixed network → Intents; bare NEAR contract → Ft.
        const exact = resolveExactBridgeToken(
            bridgeAssets,
            plainTokenAssetId,
            exactTokenNetworkId,
        );
        if (exact) return exact;

        // 4) Soft: `?networks=…` (+ optional asset id filter).
        return compatibleDefaultToken;
    }, [
        tokenParam,
        plainTokenAssetId,
        exactTokenNetworkId,
        isNativeNearPrefill,
        isConfidential,
        bridgeAssets,
        preferredNetworks.length,
        isBridgeAssetsLoading,
        compatibleDefaultToken,
    ]);

    // Let TokenSelect pick when there's no URL seed (or seed failed to resolve).
    const tokenAutoSelect =
        !tokenParam &&
        namePreferredNetworks.length === 0 &&
        !exactTokenNetworkId &&
        !isNativeNearPrefill;

    const preferredBlockchainTypes = useMemo(() => {
        const set = new Set<string>();
        for (const network of preferredNetworks) {
            const type = getBlockchainType(normalizePreferredNetwork(network));
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
            // Null until TokenSelect auto-selects or a URL override seeds.
            token: null,
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
        () =>
            watchedToken
                ? classifyPaymentToken(watchedToken, watchedDestinationNetwork)
                : null,
        [watchedToken, watchedDestinationNetwork],
    );
    const isWatchedNearNativeToken =
        watchedTokenClassification?.isNearNativeToken ?? false;
    const isWatchedNearFtToken =
        watchedTokenClassification?.isNearFtToken ?? false;

    // Strip nearcom: for format checks only — prefix is routing/display.
    const normalizedWatchedAddress = stripNearComAddressPrefix(
        watchedAddress ?? "",
    ).toLowerCase();
    const isWatchedEthImplicit = isEthImplicitNearAddress(
        normalizedWatchedAddress,
    );
    const isWatchedNearRecipient =
        isValidNearAddressFormat(normalizedWatchedAddress) &&
        !isWatchedEthImplicit;
    const isWatchedNearComRoute =
        watchedTokenClassification?.isNearComRoute ?? false;

    // True when we'll send via a direct Transfer (not through Intents).
    const isWatchedDirectTransfer =
        !isConfidential &&
        !isWatchedNearComRoute &&
        isWatchedNearRecipient &&
        (isWatchedNearNativeToken || isWatchedNearFtToken);

    // Token object to use for the 1Click quote. For native NEAR and NEAR FT we
    // swap in the nep141: prefix so the hook enables and shows a fee preview.
    // Null while assets load (before default token is seeded).
    const quoteToken = useMemo((): Token | null => {
        if (!watchedToken || !watchedTokenClassification) return null;
        if (isConfidential || isWatchedDirectTransfer) return watchedToken;
        return watchedTokenClassification.tokenForIntentsQuote;
    }, [
        watchedToken,
        isConfidential,
        isWatchedDirectTransfer,
        watchedTokenClassification,
    ]);

    // Whether this payment will go through the Intents protocol.
    const isViaIntents = !!quoteToken && isIntentsToken(quoteToken);
    const quoteContextKey = useMemo(
        () =>
            buildQuoteContextKey({
                tokenAddress: quoteToken?.address ?? "",
                amount: watchedAmount ?? "",
                address: watchedAddress ?? "",
                destinationNetwork: watchedDestinationNetwork,
                amountMode: intentsAmountMode,
            }),
        [
            quoteToken?.address,
            watchedAmount,
            watchedAddress,
            watchedDestinationNetwork,
            intentsAmountMode,
        ],
    );

    const isCrossChainIntentsToken =
        !!watchedToken && isIntentsCrossChainToken(watchedToken);
    const quoteAmountDecimals = useMemo(
        () =>
            quoteToken
                ? getQuoteAmountDecimals(
                      quoteToken,
                      watchedDestinationNetwork,
                      intentsAmountMode,
                      bridgeAssets,
                  )
                : undefined,
        [
            bridgeAssets,
            intentsAmountMode,
            quoteToken,
            watchedDestinationNetwork,
        ],
    );

    const findQuoteAssetIdFor = useCallback(
        (networkId: string | undefined): string | undefined => {
            if (!networkId || isNearComNetwork(networkId)) {
                return networkId;
            }
            for (const asset of bridgeAssets) {
                const network = asset.networks.find((n) => n.id === networkId);
                if (network) {
                    return (
                        network.quoteAssetId ||
                        network.balanceAssetId ||
                        network.id
                    );
                }
            }
            return networkId;
        },
        [bridgeAssets],
    );

    const destinationQuoteAssetId = useMemo(
        () => findQuoteAssetIdFor(watchedDestinationNetwork),
        [findQuoteAssetIdFor, watchedDestinationNetwork],
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
        destinationAmountDecimals: quoteAmountDecimals,
        address: watchedAddress,
        isConfidential,
        proposalPeriod: policy?.proposal_period,
        amountMode: intentsAmountMode,
        destinationNetwork: watchedDestinationNetwork,
        destinationQuoteAssetId,
        isPayment: true,
        // Paused payment (critical warning on token/network or app-wide): don't
        // fetch the quote. Also wait until the default token is ready.
        enabled: !paymentsSlotBlocked && !!quoteToken,
    });

    const paymentNetworkFee = useMemo(() => {
        if (!liveQuote?.quote) return null;
        const fee = computeQuoteNetworkFee(liveQuote.quote);
        return fee ? fee.replaceAll(",", "") : null;
    }, [liveQuote]);

    // Typed amounts treat fee as additive; MAX (EXACT_INPUT) already includes it.
    const balanceCheckNetworkFee =
        intentsAmountMode === "total" ? null : paymentNetworkFee;

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
        watchedToken?.address,
        watchedAmount,
        watchedAddress,
        watchedDestinationNetwork,
        intentsAmountMode,
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
        watchedToken?.address,
        watchedAmount,
        watchedAddress,
        watchedDestinationNetwork,
        intentsAmountMode,
    ]);

    const isQuoteBusy =
        isViaIntents &&
        (isLoadingLiveQuote ||
            isFetchingLiveQuote ||
            isEnsuringQuote ||
            isQuoteSyncPending);

    // ── Destination network auto-wiring ───────────────────────────────────────

    const compatibleDestination = useMemo(() => {
        if (!watchedToken) return null;

        const rawAddress = (watchedAddress ?? "").trim();
        const bareRecipient = stripNearComAddressPrefix(rawAddress);
        // nearcom: + any valid NEAR format (incl. eth-implicit 0x…).
        const isNearComRecipient =
            isConfidential &&
            hasNearComAddressPrefix(rawAddress) &&
            !!bareRecipient &&
            isValidNearAddressFormat(bareRecipient);

        // Only auto-destination: confidential nearcom:<near> → near.com.
        // Plain NEAR / eth / etc. keep the original picker compatibility path
        // (no force-to-near).
        if (isNearComRecipient) {
            return {
                id: NEAR_COM_NETWORK_ID,
                networkName: NEAR_NETWORK_ID,
            };
        }

        // Soft Ft / native NEAR → NEAR destination when recipient is empty.
        // Never soft-seed near.com (including prefersNearCom / confidential).
        if (isFtNetworkPrefill || isNativeNearPrefill) {
            if (rawAddress) return null;
            return nearChainDestination();
        }

        // Multiple soft chain prefs (address book) — leave destination empty.
        if (hasAmbiguousSoftNetworks) return null;

        // Soft multi-chain prefs: only when recipient is empty. Typing an
        // address must not keep re-resolving preferred destination.
        if (rawAddress) return null;

        if (preferredNetworks.length === 0 || bridgeAssets.length === 0) {
            return null;
        }

        // `networks=near.com` alone is not a bridge id — near.com is selected
        // only via a nearcom: address (above).
        const bridgePreferred = preferredNetworks.filter(
            (network) => network.trim().toLowerCase() !== NEAR_COM_NETWORK_ID,
        );
        if (bridgePreferred.length === 0) return null;

        const bridgeAsset = findBridgeAssetForToken(bridgeAssets, watchedToken);
        if (!bridgeAsset) return null;

        return resolvePreferredDestinationNetwork(
            bridgeAsset,
            bridgePreferred,
            preferredBlockchainTypes,
        );
    }, [
        bridgeAssets,
        preferredNetworks,
        preferredBlockchainTypes,
        watchedToken,
        watchedAddress,
        hasAmbiguousSoftNetworks,
        isFtNetworkPrefill,
        isNativeNearPrefill,
        isConfidential,
    ]);

    // Stable id/name so destination seed effect doesn't re-run every render.
    const compatibleDestinationId = compatibleDestination?.id ?? null;
    const compatibleDestinationName =
        compatibleDestination?.networkName ?? null;

    // ── Ensure quote is fresh before entering the review step ─────────────────

    const ensureQuoteBeforeReview = useCallback(async (): Promise<boolean> => {
        if (!quoteToken) return false;

        const formValues = form.getValues();
        const ensureRequestKey = buildQuoteContextKey({
            tokenAddress: quoteToken.address,
            amount: formValues.amount ?? "",
            address: formValues.address ?? "",
            destinationNetwork: formValues.destinationNetwork,
            amountMode: intentsAmountMode,
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
    }, [ensureBeforeReview, form, quoteToken, intentsAmountMode]);

    const handleAmountInput = useCallback(() => {
        setIntentsAmountMode("recipient");
    }, []);

    const handleMaxSet = useCallback(() => {
        if (isCrossChainIntentsToken) {
            setIntentsAmountMode("total");
        }
    }, [isCrossChainIntentsToken]);

    // ── Effects ───────────────────────────────────────────────────────────────

    // Seed URL token/network overrides; TokenSelect.autoSelect handles the rest.
    useEffect(() => {
        if (!urlOverrideToken) return;
        // Deep-link seeds always win over a prior selection.
        if (tokenParam || preferredNetworks.length > 0) {
            const current = form.getValues("token");
            const sameToken =
                current?.address === urlOverrideToken.address &&
                current?.residency === urlOverrideToken.residency;
            if (!sameToken) {
                form.setValue("token", urlOverrideToken);
                // Clear so destination can re-resolve for the preferred network.
                form.setValue("destinationNetwork", "");
                form.setValue("destinationNetworkName", "");
            }
            return;
        }
        const currentToken = form.getValues("token");
        if (!currentToken) {
            form.setValue("token", urlOverrideToken);
        }
    }, [urlOverrideToken, form, tokenParam, preferredNetworks.length]);

    useEffect(() => {
        const rawAddress = (watchedAddress ?? "").trim();
        const bareRecipient = stripNearComAddressPrefix(rawAddress);
        const isNearComRecipient =
            isConfidential &&
            hasNearComAddressPrefix(rawAddress) &&
            !!bareRecipient &&
            isValidNearAddressFormat(bareRecipient);

        // Drop stale near.com when the address is no longer nearcom:<near>.
        if (
            isNearComNetwork(watchedDestinationNetwork) &&
            !isNearComRecipient
        ) {
            form.setValue("destinationNetwork", "", { shouldDirty: true });
            form.setValue("destinationNetworkName", "", { shouldDirty: true });
            return;
        }

        if (!compatibleDestinationId || !compatibleDestinationName) return;
        if (watchedDestinationNetwork === compatibleDestinationId) return;

        // Soft/URL prefs only fill an empty destination. nearcom: may overwrite.
        if (!isNearComRecipient && watchedDestinationNetwork) {
            return;
        }

        form.setValue("destinationNetwork", compatibleDestinationId, {
            shouldDirty: true,
        });
        form.setValue("destinationNetworkName", compatibleDestinationName, {
            shouldDirty: true,
        });
    }, [
        compatibleDestinationId,
        compatibleDestinationName,
        form,
        watchedDestinationNetwork,
        watchedAddress,
        isConfidential,
    ]);

    // Prefill from ?address= once. Re-applying on every empty value fought the
    // recipient wipe clearer and bounced destination seed.
    const didSeedDefaultAddressRef = useRef(false);
    useEffect(() => {
        if (!defaultAddress || didSeedDefaultAddressRef.current) return;
        didSeedDefaultAddressRef.current = true;
        if (form.getValues("address") === defaultAddress) return;
        form.setValue("address", defaultAddress, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
        });
    }, [defaultAddress, form]);

    useEffect(() => {
        if (!isCrossChainIntentsToken) {
            setIntentsAmountMode("recipient");
        }
    }, [isCrossChainIntentsToken]);

    // ── Submit ────────────────────────────────────────────────────────────────

    const onSubmit = async (data: PaymentFormValues) => {
        if (paymentsSlotBlocked) {
            if (sendScopeMessage) toast.error(sendScopeMessage);
            return;
        }
        const token = data.token;
        if (!token) return;

        try {
            const proposalBond = policy?.proposal_bond || "0";
            // Form may include nearcom: (routing/display). 1Click gets bare via
            // buildIntentsQuoteRequest; direct transfers use bareAddress.
            const trimmedAddress = data.address.trim();
            const bareAddress = stripNearComAddressPrefix(trimmedAddress);
            const tokenClassification = classifyPaymentToken(
                token,
                data.destinationNetwork,
            );
            const normalizedNearAddress = bareAddress.toLowerCase();
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
                ? isIntentsToken(token)
                : !shouldUseDirectTransfer;

            const directTransferAmount = Big(data.amount)
                .mul(Big(10).pow(token.decimals))
                .toFixed();

            let description = encodeToMarkdown({ notes: data.memo || "" });
            let proposalKind: FunctionCallKind | TransferKind;

            if (shouldUseIntents) {
                const proposalPeriod = policy?.proposal_period;
                if (!proposalPeriod) {
                    throw new Error(tPay("failed1ClickQuote"));
                }
                const amountDecimals = getQuoteAmountDecimals(
                    tokenClassification.tokenForIntentsQuote,
                    data.destinationNetwork,
                    intentsAmountMode,
                    bridgeAssets,
                );
                if (amountDecimals === undefined) {
                    throw new Error(tPay("failed1ClickQuote"));
                }
                const quoteAmount = Big(data.amount)
                    .mul(Big(10).pow(amountDecimals))
                    .toFixed();
                const tokenForQuote = tokenClassification.tokenForIntentsQuote;

                // Use the cached quote from the live hook; fall back to a
                // fresh fetch if the cache is empty (e.g. first load).
                const submitQuoteKey = buildQuoteContextKey({
                    tokenAddress: tokenForQuote.address,
                    amount: data.amount ?? "",
                    address: trimmedAddress,
                    destinationNetwork: data.destinationNetwork,
                    amountMode: intentsAmountMode,
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
                            proposalPeriod,
                            undefined,
                            data.destinationNetwork,
                            true, // isPayment
                            {
                                destinationQuoteAssetId:
                                    findQuoteAssetIdFor(
                                        data.destinationNetwork,
                                    ) ?? data.destinationNetwork,
                            },
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

                    if (isIntentsToken(token)) {
                        proposalKind = buildIntentsTransferProposal(
                            token.address,
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
                            token.address,
                            depositAddress,
                            amountIn,
                        );
                    }
                }
            } else {
                // Direct NEAR or NEAR FT transfer
                proposalKind = buildDirectTransferKind(
                    bareAddress,
                    token,
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
                        token_symbol: token.symbol,
                        amount: data.amount,
                    });
                    form.reset();
                    cachedQuoteRef.current = null;
                    setIntentsAmountMode("recipient");
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
                    networkFee: balanceCheckNetworkFee,
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
                    onAmountInput: handleAmountInput,
                    onMaxSet: handleMaxSet,
                    onAddressBookSelectionChange:
                        setIsAddressBookRecipientSelected,
                    bridgeAssets,
                    isBridgeAssetsLoading:
                        isBridgeAssetsLoading || isBridgeAssetsFetching,
                    paymentsSlotBlocked,
                    sendWarningMessage,
                    recipientNetworkWarningMessage,
                    tokenAutoSelect,
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
            balanceCheckNetworkFee,
            isQuoteBusy,
            isViaIntents,
            hasLiveQuoteError,
            liveQuoteErrorMessage,
            hasInvalidRecipientAddressError,
            ensureQuoteBeforeReview,
            handleAmountInput,
            handleMaxSet,
            liveQuote,
            isLoadingLiveQuote,
            isFetchingLiveQuote,
            bridgeAssets,
            isBridgeAssetsLoading,
            isBridgeAssetsFetching,
            paymentsSlotBlocked,
            sendWarningMessage,
            recipientNetworkWarningMessage,
            tokenAutoSelect,
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
