import { useTranslations } from "next-intl";
import { useState } from "react";
import { useBatchPayment, useToken } from "@/hooks/use-treasury-queries";
import { useBulkPaymentTransactionHash } from "@/hooks/use-bulk-payment-transactions";
import { useIntentsWithdrawalFee } from "@/hooks/use-intents-withdrawal-fee";
import { BatchPaymentRequestData } from "../../types/index";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Amount } from "../amount";
import { BatchPayment, PaymentStatus } from "@/lib/api";
import { Button } from "@/components/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ArrowUpRight, ChevronDown, FileText, SearchX } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { getTransactionExplorerLink } from "@/lib/blockchain-utils";
import { cn } from "@/lib/utils";
import { User } from "@/components/user";
import Link from "next/link";
import { StatusPill } from "../proposal-status-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Proposal } from "@/lib/proposals-api";
import Big from "@/lib/big";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { NetworkIconDisplay } from "@/components/token-display";
import { formatRecipientForNearComDestination } from "@/lib/nearcom-address";
import { useDestinationNetworkMeta } from "../../hooks/use-destination-network-meta";
import { useRequestDisplayContext } from "./common/request-display-context";
import { useTreasury } from "@/hooks/use-treasury";

interface PaymentDisplayProps {
    number: number;
    payment: BatchPayment;
    expanded: boolean;
    onExpandedClick: () => void;
    tokenId: string;
    /**
     * Asset id used for the amount row (icon / decimals / network badge).
     * Confidential bulk passes the destination asset so the badge shows the
     * receive network; defaults to `tokenId` (send/origin).
     */
    amountTokenId?: string;
    /** Network name override for the amount tooltip / badge label. */
    amountNetwork?: string;
    batchId: string;
    proposalId: number;
    showReceiptButton: boolean;
    chainName: string;
    /** Receive network — only `near.com` gets a nearcom: display prefix. */
    destinationAssetId?: string;
}

const paymentStatusToText = (status: PaymentStatus): "Pending" | "Paid" => {
    if (typeof status === "string") {
        return status;
    }
    return Object.keys(status)[0] as "Pending" | "Paid";
};

function PaymentDisplay({
    number,
    payment,
    expanded,
    onExpandedClick,
    tokenId,
    amountTokenId,
    amountNetwork,
    batchId,
    proposalId,
    showReceiptButton,
    chainName,
    destinationAssetId,
}: PaymentDisplayProps) {
    const t = useTranslations("proposals.expanded");
    const tReceipt = useTranslations("receiptPage");
    const { treasuryId } = useTreasury();
    const status = paymentStatusToText(payment.status);
    const isPaid = status === "Paid";
    const resolvedAmountTokenId = amountTokenId || tokenId;
    const displayRecipient = formatRecipientForNearComDestination(
        payment.recipient,
        destinationAssetId,
    );
    const { data: txData } = useBulkPaymentTransactionHash(
        isPaid ? batchId : null,
        isPaid ? payment.recipient : null,
    );
    const transactionHash = txData?.transactionHash;

    // Batch payment transactions execute on NEAR (nearblocks link).
    const explorerLink = getTransactionExplorerLink({ transactionHash });

    let items: InfoItem[] = [
        {
            label: t("recipient"),
            value: (
                <User
                    accountId={payment.recipient}
                    displayAddress={displayRecipient}
                    chainName={chainName}
                    preferAddressBook
                />
            ),
        },
        {
            label: t("amount"),
            value: (
                <Amount
                    amount={payment.amount.toString()}
                    showNetworkTooltip
                    tokenId={resolvedAmountTokenId}
                    network={amountNetwork}
                />
            ),
        },
    ];

    if (status !== "Pending") {
        items.push({
            label: t("status"),
            value: <StatusPill status={status} />,
        });
    }

    if (isPaid && explorerLink) {
        items.push({
            label: t("transactionLink"),
            value: (
                <Link
                    className="flex items-center gap-2"
                    href={explorerLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t("viewTransaction")} <ArrowUpRight className="size-4" />
                </Link>
            ),
        });
    }

    return (
        <Collapsible open={expanded} onOpenChange={onExpandedClick}>
            <CollapsibleTrigger
                className={cn(
                    "w-full flex justify-between items-center p-3 border rounded-lg",
                    expanded && "rounded-b-none",
                )}
            >
                <div className="flex gap-2 items-center">
                    <ChevronDown
                        className={cn("w-4 h-4", expanded && "rotate-180")}
                    />
                    {t("recipientNumber", { number })}
                </div>
                <div className="hidden md:flex gap-3 items-baseline text-sm text-muted-foreground">
                    <User
                        accountId={payment.recipient}
                        displayAddress={displayRecipient}
                        variant="details"
                        withLink={false}
                        preferAddressBook
                    />
                    <Amount
                        amount={payment.amount.toString()}
                        textOnly
                        showNetworkTooltip
                        tokenId={resolvedAmountTokenId}
                        network={amountNetwork}
                        showUSDValue={false}
                    />
                    {showReceiptButton && (
                        <Button
                            asChild
                            variant="ghost"
                            size="icon-sm"
                            tooltipContent={tReceipt("generateReceipt")}
                            className="h-7 w-7"
                        >
                            <Link
                                href={`/${treasuryId}/requests/${proposalId}/receipt?recipient=${encodeURIComponent(payment.recipient)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <FileText className="size-4" />
                            </Link>
                        </Button>
                    )}
                </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <InfoDisplay
                    style="secondary"
                    className="p-3 rounded-b-lg"
                    items={items}
                />
            </CollapsibleContent>
        </Collapsible>
    );
}

interface BatchPaymentExpandedViewProps {
    /** Resolved token id (e.g. `near` or contract id). */
    tokenId: string;
    /** Total amount across all recipients in smallest units. */
    totalAmount: string;
    /** Notes — rendered below the table when present. */
    notes?: string;
    /** Per-recipient rows. */
    payments: BatchPayment[];
    /**
     * Optional batch id used by the public flow's per-row transaction-hash
     * lookup. Confidential bulk passes `null` (no on-chain hash to link).
     */
    batchId?: string | null;
    /**
     * Pre-computed total network fee in human-readable token units.
     * Confidential bulk passes the sum of
     * `(amountInFormatted - amountOutFormatted)` from each recipient's
     * stored 1Click quote — the actual fee the DAO already committed to.
     * Formatted amounts are required when origin/destination decimals differ.
     * When provided, skips the live SDK estimate.
     */
    totalNetworkFeeOverride?: string | null;
    /** On-chain proposal id — used to build per-recipient receipt links. */
    proposalId?: number;
    /**
     * Whether to show the per-recipient "generate receipt" button. Enabled for
     * executed public and confidential bulk payments.
     */
    showReceiptButton?: boolean;
    /**
     * Confidential bulk receive-network asset id (bridge asset or near.com).
     * When set, request details show Destination Network and recipient links
     * use that chain — not the send/origin token network.
     */
    destinationAssetId?: string;
}

/**
 * Pure renderer shared by public and confidential bulk-payment expanded views.
 * Public wrapper feeds it via `useBatchPayment`; confidential wrapper feeds
 * it via `confidential_metadata.bulk.recipients`.
 */
export function BatchPaymentExpandedView({
    tokenId,
    totalAmount,
    notes,
    payments,
    batchId,
    totalNetworkFeeOverride,
    proposalId,
    showReceiptButton = false,
    destinationAssetId,
}: BatchPaymentExpandedViewProps) {
    const t = useTranslations("proposals.expanded");
    const tIntents = useTranslations("intentsQuote");
    const [expanded, setExpanded] = useState<number[]>([]);

    const { data: tokenData } = useToken(tokenId);
    const {
        recipientChainName,
        destinationNetworkMeta,
        shouldShowDestinationNetworkSkeleton,
        amountTokenId,
        amountNetwork,
    } = useDestinationNetworkMeta({
        destinationAssetId,
        originTokenId: tokenId,
        originNetwork: tokenData?.network || NEAR_NETWORK_ID,
        originChainIcons: tokenData?.chainIcons,
    });

    const representativeRecipient = payments[0]?.recipient;
    const skipLiveFee = totalNetworkFeeOverride != null;
    const {
        data: dynamicFeeData,
        isError: hasFeeError,
        isIntentsCrossChainToken,
    } = useIntentsWithdrawalFee({
        token:
            !skipLiveFee && tokenData
                ? {
                      address: tokenId,
                      network: tokenData.network || "near",
                      decimals: tokenData.decimals,
                  }
                : null,
        destinationAddress: skipLiveFee ? undefined : representativeRecipient,
    });

    const hasLiveFeeData =
        !skipLiveFee &&
        isIntentsCrossChainToken &&
        !hasFeeError &&
        !!dynamicFeeData?.networkFee;
    // Confidential bulk passes a pre-summed override already in token units
    // (from formatted quote amounts). Public bulk falls back to the live
    // SDK estimate × recipient count.
    const totalNetworkFee = skipLiveFee
        ? Big(totalNetworkFeeOverride).gt(0)
            ? Big(totalNetworkFeeOverride)
            : null
        : hasLiveFeeData
          ? Big(dynamicFeeData.networkFee).mul(payments.length)
          : null;

    const onExpandedChanged = (index: number) => {
        setExpanded((prev) =>
            prev.includes(index)
                ? prev.filter((id) => id !== index)
                : [...prev, index],
        );
    };

    const isAllExpanded = expanded.length === payments.length;
    const toggleAllExpanded = () => {
        if (isAllExpanded) setExpanded([]);
        else setExpanded(payments.map((_, index) => index));
    };

    const items: InfoItem[] = [
        {
            label: t("totalAmount"),
            value: (
                <Amount
                    showNetwork={!destinationAssetId}
                    showNetworkTooltip
                    amount={totalAmount}
                    tokenId={tokenId}
                />
            ),
        },
        ...(destinationAssetId
            ? [
                  {
                      label: t("destinationNetwork"),
                      value: shouldShowDestinationNetworkSkeleton ? (
                          <Skeleton className="h-5 w-28" />
                      ) : (
                          <NetworkIconDisplay
                              chainIcons={destinationNetworkMeta.chainIcons}
                              networkName={destinationNetworkMeta.name}
                              networkNameClassName="font-normal"
                          />
                      ),
                  } satisfies InfoItem,
              ]
            : []),
        ...(totalNetworkFee
            ? [
                  {
                      label: t("networkFee"),
                      info: tIntents("networkFeeTooltip"),
                      value: `${totalNetworkFee.toString()} ${tokenData?.symbol || ""}`.trim(),
                  } satisfies InfoItem,
              ]
            : []),
        {
            label: t("recipients"),
            value: (
                <div className="flex gap-3 items-baseline">
                    <p className="text-sm font-medium">
                        {t("recipientsCount", { count: payments.length })}
                    </p>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleAllExpanded}
                    >
                        {isAllExpanded ? t("collapseAll") : t("expandAll")}
                    </Button>
                </div>
            ),
            afterValue: (
                <div className="flex flex-col gap-1">
                    {payments.map((payment, index) => (
                        <PaymentDisplay
                            tokenId={tokenId}
                            amountTokenId={amountTokenId}
                            amountNetwork={amountNetwork}
                            number={index + 1}
                            key={index}
                            payment={payment}
                            expanded={expanded.includes(index)}
                            onExpandedClick={() => onExpandedChanged(index)}
                            batchId={batchId ?? ""}
                            proposalId={proposalId ?? 0}
                            showReceiptButton={showReceiptButton}
                            chainName={recipientChainName}
                            destinationAssetId={destinationAssetId}
                        />
                    ))}
                </div>
            ),
        },
    ];

    return (
        <>
            <InfoDisplay items={items} />
            {notes && notes !== "" && (
                <div className="flex justify-between gap-2 p-3 pt-0 mt-[-10px]">
                    <p className="text-sm text-muted-foreground">
                        {t("notes")}
                    </p>
                    <p className="text-sm font-medium">{notes}</p>
                </div>
            )}
        </>
    );
}

interface BatchPaymentRequestExpandedProps {
    data: BatchPaymentRequestData;
    proposal: Proposal;
}

export function BatchPaymentRequestExpanded({
    data,
    proposal,
}: BatchPaymentRequestExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const { isConfidential } = useTreasury();
    const requestDisplayContext = useRequestDisplayContext()!;

    // Only auto-refetch while the proposal is Executed (payments in flight).
    const isExecuted = requestDisplayContext.isExecuted;

    const {
        data: batchData,
        isLoading,
        isError,
    } = useBatchPayment(data.batchId);

    const hasPendingPayments = batchData?.payments?.some(
        (payment) => paymentStatusToText(payment.status) === "Pending",
    );

    const shouldAutoRefetch = isExecuted && hasPendingPayments;
    const { data: liveBatchData } = useBatchPayment(
        data.batchId,
        shouldAutoRefetch ? 5000 : false,
    );
    const activeBatchData = shouldAutoRefetch ? liveBatchData : batchData;

    if (isLoading) {
        return (
            <div className="space-y-6 py-4">
                <div className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-6 w-48" />
                </div>
                <div className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-6 w-32" />
                    <div className="flex flex-col gap-2 mt-4">
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
                    </div>
                </div>
            </div>
        );
    }

    if (isError || !activeBatchData) {
        return (
            <EmptyState
                icon={SearchX}
                title={t("oopsTitle")}
                description={t("oopsDescription")}
            />
        );
    }

    let tokenId = data.tokenId;
    if (activeBatchData.tokenId?.toLowerCase() === "native") {
        tokenId = NEAR_NETWORK_ID;
    }
    const showReceiptButton = isExecuted && !isConfidential;

    return (
        <BatchPaymentExpandedView
            tokenId={tokenId}
            totalAmount={data.totalAmount}
            notes={data.notes}
            payments={activeBatchData.payments}
            batchId={data.batchId}
            proposalId={proposal.id}
            showReceiptButton={showReceiptButton}
            destinationAssetId={data.destinationAssetId}
        />
    );
}
