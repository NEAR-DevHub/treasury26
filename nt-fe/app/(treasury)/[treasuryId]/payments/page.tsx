"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
    InformationCircleIcon,
    UserGroup03Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Address } from "@/components/address";
import { AmountSummary } from "@/components/amount-summary";
import { Button } from "@/components/button";
import { CreateRequestButton } from "@/components/create-request-button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { Input } from "@/components/input";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    ReviewStep,
    type StepProps,
    StepWizard,
} from "@/components/step-wizard";
import { getNetworkDisplayName } from "@/components/token-display";
import { TokenDisplay } from "@/components/token-display-with-network";
import { type Token, tokenSchema } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { Form, FormField } from "@/components/ui/form";
import { SlotWarning } from "@/components/warning-message";
import {
    NEAR_COM_NETWORK_ID,
    NEAR_COM_NETWORK_NAME,
    NEAR_NETWORK_ID,
} from "@/constants/network-ids";
import { default_near_token, default_usdc_near_token } from "@/constants/token";
import { findAddressBookEntry, useAddressBook } from "@/features/address-book";
import {
    PAGE_TOUR_NAMES,
    PAGE_TOUR_STORAGE_KEYS,
    usePageTour,
} from "@/features/onboarding/steps/page-tours";
import { type BridgeAsset, useTokenCatalog } from "@/hooks/use-bridge-tokens";
import {
    buildIntentsQuoteRequest,
    type IntentsAmountMode,
    useIntentsQuote,
} from "@/hooks/use-intents-quote";
import { useTreasury } from "@/hooks/use-treasury";
import { useToken, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
    scopedFieldMessage,
    useBridgeScopedWarning,
    useScopedSlotWarning,
} from "@/hooks/use-warnings";
import { decimalFromBaseUnitsOrNull, decimalOrNull } from "@/lib/amount-format";
import { trackEvent } from "@/lib/analytics";
import type { IntentsQuoteResponse } from "@/lib/api";
import { generateIntent, getIntentsQuote } from "@/lib/api";
import Big from "@/lib/big";
import { getBlockchainType } from "@/lib/blockchain-utils";
import { findBridgeAssetForToken } from "@/lib/bridge-asset-resolver";
import {
    SHORT_ADDRESS_PREFIX_LENGTH,
    SHORT_ADDRESS_SUFFIX_LENGTH,
} from "@/lib/format-short-address";
import {
    computeQuoteNetworkFee,
    isIntentsCrossChainToken,
    isIntentsToken,
} from "@/lib/intents-fee";
import {
    getNearComChainIcons,
    getNetworkDisplayCaseClass,
    isNearComNetwork,
} from "@/lib/intents-network";
import {
    buildIntentsTransferProposal,
    buildNativeNearIntentsKind,
    buildNearFtIntentsKind,
} from "@/lib/near-proposal-builders";
import { findQuoteAssetIdForDestination } from "@/lib/oneclick-asset-routing";
import {
    classifyPaymentToken,
    normalizePaymentRecipient,
    shouldUseDirectPaymentTransfer,
} from "@/lib/payment-route";
import type { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import {
    canAddressUseDestination,
    checkRecipientAddressFormat,
} from "@/lib/recipient-address-rules";
import { reportError } from "@/lib/report-error";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import { cn, encodeToMarkdown } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
import { PaymentFormSection } from "./components/payment-form-section";
import {
    isBareNearContractId,
    isIntentsNetworkId,
    isJsonTokenQueryParam,
    nearChainDestination,
    normalizePreferredNetwork,
    parseSoftNetworks,
    pickCompatibleFallbackToken,
    resolveExactBridgeToken,
    isNativeNearPrefill as resolveIsNativeNearPrefill,
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
    selectDestination: string;
    invalidAddress: string;
}) {
    return z
        .object({
            address: z
                .string()
                .min(2, messages.recipientMin)
                .max(128, messages.recipientMax),
            destinationNetwork: z.string().min(1, messages.selectDestination),
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
            const addressIssue = checkRecipientAddressFormat({
                address: data.address,
                network: data.destinationNetworkName || data.destinationNetwork,
                isNearComDestination: isNearComNetwork(data.destinationNetwork),
            });
            if (addressIssue && addressIssue !== "unknownDestination") {
                ctx.addIssue({
                    code: "custom",
                    path: ["address"],
                    message: messages.invalidAddress,
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
    balanceOverrideRaw?: string | null;
    /** Live quote USD to confirm price→token conversion in the amount field. */
    usdValueOverride?: number | null;
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
    balanceOverrideRaw = null,
    usdValueOverride = null,
}: Step1Props) {
    const tPay = useTranslations("payments");
    const tCreate = useTranslations("createRequestButton");
    const form = useFormContext<PaymentFormValues>();
    const address = form.watch("address");
    const amount = form.watch("amount");
    const destinationNetwork = form.watch("destinationNetwork");

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

    const hasAmount = !!amount && Number(amount) > 0;
    const hasRecipient = !!address?.trim();
    const hasDestination = !!destinationNetwork?.trim();
    const saveButtonText = paymentsSlotBlocked
        ? tCreate("brieflyUnavailable")
        : hasRestrictedRecipientError
          ? tPay("useDifferentAddress")
          : hasAmount && hasRecipient && hasDestination
            ? tPay("reviewButton")
            : !hasRecipient
              ? tPay("reviewButtonEnterRecipient")
              : !hasDestination
                ? tPay("reviewButtonEnterNetwork")
                : tPay("reviewButtonDisabled");

    return (
        <>
            <SlotWarning slot="payments" />
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
                recipientNetworkWarningMessage={recipientNetworkWarningMessage}
                tokenAutoSelect={tokenAutoSelect}
                balanceOverrideRaw={balanceOverrideRaw}
                usdValueOverride={usdValueOverride}
            />
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
    const contactName = findAddressBookEntry(addressBook, address)?.name;

    const { recipientAmount, displayNetworkFee, recipientEstimatedUSDValue } =
        useMemo(() => {
            if (!token) {
                return {
                    totalAmountWithFees: Big(0),
                    recipientAmount: Big(0),
                    displayNetworkFee: Big(0),
                    estimatedUSDValue: null,
                    recipientEstimatedUSDValue: null,
                };
            }

            const enteredAmount = decimalOrNull(amount) ?? Big(0);
            const price = decimalOrNull(tokenData?.price);

            if (liveQuote?.quote) {
                const quotedTotal =
                    decimalFromBaseUnitsOrNull(
                        liveQuote.quote.amountIn || liveQuote.quote.minAmountIn,
                        token.decimals,
                    ) ??
                    decimalOrNull(liveQuote.quote.amountInFormatted) ??
                    Big(0);
                const quotedRecipient =
                    decimalOrNull(liveQuote.quote.amountOutFormatted) ??
                    decimalFromBaseUnitsOrNull(
                        liveQuote.quote.amountOut ||
                            liveQuote.quote.minAmountOut,
                        token.decimals,
                    ) ??
                    Big(0);
                const feeValue =
                    decimalOrNull(computeQuoteNetworkFee(liveQuote.quote)) ??
                    Big(0);

                return {
                    totalAmountWithFees: quotedTotal,
                    recipientAmount: quotedRecipient,
                    displayNetworkFee: feeValue,
                    estimatedUSDValue:
                        decimalOrNull(liveQuote.quote.amountInUsd) ??
                        (price?.gt(0) ? quotedTotal.mul(price) : null),
                    recipientEstimatedUSDValue:
                        decimalOrNull(liveQuote.quote.amountOutUsd) ??
                        (price?.gt(0) ? quotedRecipient.mul(price) : null),
                };
            }

            return {
                totalAmountWithFees: enteredAmount,
                recipientAmount: enteredAmount,
                displayNetworkFee: Big(0),
                estimatedUSDValue: price?.gt(0)
                    ? enteredAmount.mul(price)
                    : null,
                recipientEstimatedUSDValue: price?.gt(0)
                    ? enteredAmount.mul(price)
                    : null,
            };
        }, [amount, liveQuote, token, tokenData?.price]);

    const isQuoteLoading =
        isViaIntents && (isLoadingLiveQuote || isFetchingLiveQuote);

    if (!token) return null;

    return (
        <div className="flex flex-col gap-4">
            <ReviewStep
                reviewingTitle={tPay("reviewYourPayment")}
                handleBack={handleBack}
            >
                <AmountSummary
                    total={recipientAmount}
                    totalUSD={recipientEstimatedUSDValue}
                    token={token}
                    title=""
                    showNetworkIcon={true}
                    chainIcons={destinationChainIcons ?? token.chainIcons}
                />
                <div className="flex w-full flex-col gap-4 mt-2">
                    <div className="flex w-full items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            {contactName && (
                                <p className="text-sm font-semibold leading-normal text-general-foreground">
                                    {contactName}
                                </p>
                            )}
                            <Address
                                address={address}
                                prefixLength={SHORT_ADDRESS_PREFIX_LENGTH}
                                suffixLength={SHORT_ADDRESS_SUFFIX_LENGTH}
                                className="text-sm font-semibold leading-normal text-general-foreground"
                            />
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                            <div className="flex items-center gap-1.5">
                                <TokenDisplay
                                    icon={token.icon}
                                    symbol={token.symbol}
                                    iconSize="md"
                                    className="shrink-0"
                                />
                                <span className="text-sm font-semibold leading-normal text-general-foreground">
                                    <FormattedAmount
                                        kind="token"
                                        value={recipientAmount}
                                        symbol={token.symbol}
                                        tokenDecimals={token.decimals}
                                        unitPriceUsd={tokenData?.price}
                                        profile="standard"
                                    />
                                </span>
                            </div>
                            {recipientEstimatedUSDValue ? (
                                <p className="whitespace-nowrap text-xs font-normal leading-4 text-general-secondary-foreground">
                                    ≈{" "}
                                    <FormattedAmount
                                        kind="fiat"
                                        value={recipientEstimatedUSDValue}
                                    />
                                </p>
                            ) : null}
                        </div>
                    </div>

                    {destinationNetwork ? (
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium leading-normal text-general-secondary-foreground">
                                {tPay("destinationNetwork")}
                            </p>
                            <div className="flex items-center gap-1.5">
                                {destinationChainIcons?.icon ? (
                                    <img
                                        src={destinationChainIcons.icon}
                                        alt=""
                                        className="size-3.5 overflow-hidden rounded-full object-cover"
                                    />
                                ) : null}
                                <span
                                    className={cn(
                                        "text-sm font-semibold leading-normal text-general-foreground",
                                        getNetworkDisplayCaseClass(
                                            destinationNetwork,
                                        ),
                                    )}
                                >
                                    {isNearComNetwork(destinationNetwork)
                                        ? NEAR_COM_NETWORK_NAME
                                        : getNetworkDisplayName(
                                              form.getValues(
                                                  "destinationNetworkName",
                                              ) || destinationNetwork,
                                          )}
                                </span>
                            </div>
                        </div>
                    ) : null}

                    {isViaIntents && displayNetworkFee.gt(0) && (
                        <div className="flex items-center justify-between gap-2 text-sm">
                            <div className="flex items-center gap-1 text-muted-foreground">
                                <p>{tPay("networkFee")}</p>
                                <Tooltip
                                    content={tIntents("networkFeeTooltip")}
                                    side="top"
                                >
                                    <Icon
                                        icon={InformationCircleIcon}
                                        className="shrink-0"
                                        aria-label={tPay("networkFeeInfo")}
                                    />
                                </Tooltip>
                            </div>
                            <p>
                                <FormattedAmount
                                    kind="token"
                                    value={displayNetworkFee}
                                    symbol={token.symbol}
                                    tokenDecimals={token.decimals}
                                    unitPriceUsd={tokenData?.price}
                                    profile="standard"
                                    rounding="up"
                                />
                            </p>
                        </div>
                    )}

                    <FormField
                        control={form.control}
                        name="memo"
                        render={({ field }) => (
                            <Input
                                value={field.value}
                                onChange={field.onChange}
                                placeholder={tPay("commentPlaceholder")}
                                inputClassName="h-11 rounded-xl border border-general-border bg-general-bg-tertiary! hover:bg-general-bg-tertiary! focus-visible:border-general-border focus-visible:ring-0"
                            />
                        )}
                    />
                </div>
            </ReviewStep>

            <CreateRequestButton
                isSubmitting={form.formState.isSubmitting || isQuoteLoading}
                type="submit"
                className="w-full h-11 rounded-2xl"
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
    );
}

type PaymentFormValues = z.infer<ReturnType<typeof buildPaymentFormSchema>>;

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
    const tFormSection = useTranslations("paymentFormSection");
    const paymentFormSchema = useMemo(
        () =>
            buildPaymentFormSchema({
                recipientMin: tValidation("recipientMin"),
                recipientMax: tValidation("recipientMax"),
                amountGreaterThanZero: tValidation("amountGreaterThanZero"),
                recipientSameAsToken: tValidation("recipientSameAsToken"),
                selectToken: tValidation("selectToken"),
                selectDestination: tValidation("selectDestination"),
                invalidAddress: tFormSection("invalidAddress"),
            }),
        [tValidation, tFormSection],
    );
    const { treasuryId, isConfidential } = useTreasury();
    const pageTitle = t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [step, setStep] = useState(0);
    usePageTour(
        PAGE_TOUR_NAMES.PAYMENTS_BULK,
        PAGE_TOUR_STORAGE_KEYS.PAYMENTS_BULK_SHOWN,
        { enabled: step === 0 },
    );
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
    } = useTokenCatalog({ kind: "swap" });
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
        () => (watchedToken ? classifyPaymentToken(watchedToken) : null),
        [watchedToken],
    );

    // True when we'll send via a direct Transfer (not through Intents).
    const isWatchedDirectTransfer =
        !!watchedToken &&
        shouldUseDirectPaymentTransfer({
            token: watchedToken,
            destinationNetwork: watchedDestinationNetwork,
            recipient: watchedAddress ?? "",
            isConfidential,
        });

    // Token object to use for the 1Click quote. For native NEAR and NEAR FT we
    // swap in the nep141: prefix so the hook enables and shows a fee preview.
    // Null while assets load (before default token is seeded).
    const quoteToken = useMemo((): Token | null => {
        if (!watchedToken || !watchedTokenClassification) return null;
        if (isWatchedDirectTransfer) return watchedToken;
        return watchedTokenClassification.tokenForIntentsQuote;
    }, [watchedToken, isWatchedDirectTransfer, watchedTokenClassification]);

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
            // Receiver network decides the 1Click destination id (balance vs
            // 1cs routing alias, e.g. nBTC → native BTC on Bitcoin).
            return findQuoteAssetIdForDestination(bridgeAssets, networkId);
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

    // Quote USD confirms the price→token conversion shown in the amount field.
    // EXACT_OUTPUT (typed amount) → amountOutUsd; EXACT_INPUT (MAX) → amountInUsd.
    const quoteAmountUsd = useMemo(() => {
        const quote = liveQuote?.quote;
        if (!quote) return null;
        const raw =
            intentsAmountMode === "total"
                ? quote.amountInUsd
                : quote.amountOutUsd;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    }, [liveQuote, intentsAmountMode]);

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
        // Recipient-first: never seed a destination before an address.
        if (!rawAddress) return null;

        // Soft Ft / native NEAR → NEAR destination when the address can use it.
        if (isFtNetworkPrefill || isNativeNearPrefill) {
            const near = nearChainDestination();
            return canAddressUseDestination({
                address: rawAddress,
                network: near.networkName,
            })
                ? near
                : null;
        }

        // Multiple soft chain prefs (address book) — leave destination empty.
        if (hasAmbiguousSoftNetworks) return null;

        if (preferredNetworks.length === 0) return null;

        const preferredNearCom = preferredNetworks.find(
            (network) => network.trim().toLowerCase() === NEAR_COM_NETWORK_ID,
        );
        if (preferredNearCom) {
            const dest = {
                id: NEAR_COM_NETWORK_ID,
                networkName: NEAR_NETWORK_ID,
            };
            return canAddressUseDestination({
                address: rawAddress,
                network: dest.networkName,
                isNearComDestination: true,
            })
                ? dest
                : null;
        }

        if (bridgeAssets.length === 0) return null;

        const bridgeAsset = findBridgeAssetForToken(bridgeAssets, watchedToken);
        if (!bridgeAsset) return null;

        const preferred = resolvePreferredDestinationNetwork(
            bridgeAsset,
            preferredNetworks,
            preferredBlockchainTypes,
        );
        if (!preferred) return null;
        return canAddressUseDestination({
            address: rawAddress,
            network: preferred.networkName,
            isNearComDestination: isNearComNetwork(preferred.id),
        })
            ? preferred
            : null;
    }, [
        bridgeAssets,
        preferredNetworks,
        preferredBlockchainTypes,
        watchedToken,
        watchedAddress,
        hasAmbiguousSoftNetworks,
        isFtNetworkPrefill,
        isNativeNearPrefill,
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

    // Deep-link destination applies once. After that the destination is the
    // user's to pick: re-seeding would fight the clear that follows every
    // recipient edit and silently re-fill a field they were asked to choose.
    const didSeedDestinationRef = useRef(false);
    useEffect(() => {
        if (didSeedDestinationRef.current) return;
        if (!compatibleDestinationId || !compatibleDestinationName) return;

        didSeedDestinationRef.current = true;
        if (watchedDestinationNetwork) return;

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
    ]);

    // Token is the top of the chain, so changing it invalidates everything
    // below: the recipient, the destinations that recipient could reach, and
    // the amount its balance allowed. Changing the destination clears nothing
    // — it sits below the recipient and above the amount, which the quote
    // re-checks against the new route.
    const prevTokenKeyRef = useRef<string | null>(null);

    useEffect(() => {
        const tokenKey = watchedToken
            ? `${watchedToken.address}:${watchedToken.residency ?? ""}:${watchedToken.network ?? ""}`
            : "";

        const previous = prevTokenKeyRef.current;
        prevTokenKeyRef.current = tokenKey;
        if (previous === null || previous === tokenKey) return;

        form.setValue("address", "", { shouldDirty: true });
        form.setValue("amount", "", { shouldDirty: true });
        form.setValue("destinationNetwork", "", { shouldDirty: true });
        form.setValue("destinationNetworkName", "", { shouldDirty: true });
        form.clearErrors(["address", "amount", "destinationNetwork"]);
        setIsAddressBookRecipientSelected(false);
        setIntentsAmountMode("recipient");
    }, [watchedToken, form]);

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
            const bareAddress = normalizePaymentRecipient(trimmedAddress);
            const tokenClassification = classifyPaymentToken(token);
            const { isNearNativeToken } = tokenClassification;

            const shouldUseDirectTransfer = shouldUseDirectPaymentTransfer({
                token,
                destinationNetwork: data.destinationNetwork,
                recipient: trimmedAddress,
                isConfidential,
            });

            const shouldUseIntents = !shouldUseDirectTransfer;

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
                            intentsAmountMode,
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
                })
                .catch((error) => {
                    reportError(error, "payments.createProposal");
                });
        } catch (error) {
            reportError(error, "payments.submit");
            toast.error(
                error instanceof Error && error.message
                    ? error.message
                    : tPay("failed1ClickQuote"),
            );
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
                    usdValueOverride: quoteAmountUsd,
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
            quoteAmountUsd,
        ],
    );

    const bulkPaymentsButton = (
        <Link href={`/${treasuryId}/payments/bulk-payment`}>
            <Button
                variant="secondary"
                size="icon"
                className="size-10 rounded-xl bg-muted text-muted-foreground hover:bg-muted hover:text-foreground lg:h-9 lg:w-auto lg:rounded-md lg:bg-muted-foreground/10 lg:px-3 lg:text-sm lg:font-bold lg:leading-3.5 lg:text-general-secondary-foreground lg:hover:bg-muted-foreground/20"
                id="payments-bulk-btn"
                aria-label={tPay("bulkPayments")}
                onClick={() => {
                    trackEvent("bulk-payments-click", {
                        source: "payments_page",
                        treasury_id: treasuryId ?? "",
                    });
                }}
            >
                <Icon icon={UserGroup03Icon} />
                <span className="hidden lg:inline">{tPay("bulkPayments")}</span>
            </Button>
        </Link>
    );

    return (
        <PageComponentLayout
            title={pageTitle}
            backButton={treasuryId ? `/${treasuryId}` : true}
            backKind="section"
            hideMobileShellControls
            hideTitle={step === 1}
            headerActions={step === 0 ? bulkPaymentsButton : undefined}
        >
            <Form {...form}>
                <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="mx-auto flex max-w-lg flex-col gap-4"
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
