"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import { ExternalLink, ArrowRight } from "lucide-react";
import type { RecentActivity } from "@/lib/api";
import { FormattedDate } from "@/components/formatted-date";
import { CopyButton } from "@/components/copy-button";
import { useReceiptSearch } from "@/hooks/use-receipt-search";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { AmountSummary } from "@/components/amount-summary";
import { Skeleton } from "@/components/ui/skeleton";

interface TransactionDetailsModalProps {
    activity: RecentActivity | null;
    treasuryId: string;
    isOpen: boolean;
    onClose: () => void;
}

export function TransactionDetailsModal({
    activity,
    treasuryId,
    isOpen,
    onClose,
}: TransactionDetailsModalProps) {
    if (!activity) return null;

    const needsReceiptSearch = !activity.transactionHashes?.length;
    const { data: transactionFromReceipt, isLoading: isLoadingTransaction } =
        useReceiptSearch(
            needsReceiptSearch ? activity.receiptIds?.[0] : undefined,
        );

    const isSwap = !!activity.swap;
    const isReceived = parseFloat(activity.amount) > 0;
    const transactionType = isSwap
        ? "Swap"
        : isReceived
            ? "Payment received"
            : "Payment sent";

    // Determine From/To based on receiver_id vs treasury account
    const fromAccount = isReceived
        ? activity.counterparty || activity.signerId || "unknown"
        : treasuryId;

    const toAccount = isReceived
        ? treasuryId
        : activity.receiverId || activity.counterparty || "unknown";

    const formatModalAmount = (
        amount: string,
        decimals: number,
        signed = true,
    ) => {
        const num = parseFloat(amount);
        const absNum = Math.abs(num);
        const sign = signed ? (num >= 0 ? "+" : "-") : "";

        const decimalPlaces =
            absNum >= 1 ? 2 : Math.min(6, decimals);

        return `${sign}${absNum.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: decimalPlaces,
        })}`;
    };

    const openInExplorer = (txHash: string) => {
        window.open(`https://nearblocks.io/txns/${txHash}`, "_blank");
    };

    const transactionHash = isSwap
        ? activity.swap!.solverTransactionHash
        : activity.transactionHashes?.length
            ? activity.transactionHashes[0]
            : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[600px]">
                <DialogHeader className="border-b border-border">
                    <DialogTitle>Transaction Details</DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Transaction Summary */}
                    {isSwap && activity.swap ? (
                        <div className="flex flex-col items-center gap-2 py-4">
                            <div className="text-sm text-muted-foreground">
                                {transactionType}
                            </div>
                            <div className="flex items-center gap-3">
                                {activity.swap.sentAmount &&
                                    activity.swap.sentTokenMetadata ? (
                                    <div className="text-center">
                                        <div className="text-lg font-semibold">
                                            {formatModalAmount(
                                                activity.swap.sentAmount,
                                                activity.swap
                                                    .sentTokenMetadata
                                                    .decimals,
                                                false,
                                            )}
                                        </div>
                                        <div className="text-sm text-muted-foreground">
                                            {
                                                activity.swap
                                                    .sentTokenMetadata.symbol
                                            }
                                        </div>
                                    </div>
                                ) : (
                                    <div className="text-center">
                                        <div className="text-lg font-semibold">
                                            ?
                                        </div>
                                    </div>
                                )}
                                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
                                <div className="text-center">
                                    <div className="text-lg font-semibold">
                                        {formatModalAmount(
                                            activity.swap.receivedAmount,
                                            activity.swap
                                                .receivedTokenMetadata
                                                .decimals,
                                            false,
                                        )}
                                    </div>
                                    <div className="text-sm text-muted-foreground">
                                        {
                                            activity.swap
                                                .receivedTokenMetadata.symbol
                                        }
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <AmountSummary
                            title={transactionType}
                            total={formatModalAmount(
                                activity.amount,
                                activity.tokenMetadata.decimals,
                            )}
                            token={{
                                address: activity.tokenMetadata.tokenId,
                                symbol: activity.tokenMetadata.symbol,
                                decimals: activity.tokenMetadata.decimals,
                                name: activity.tokenMetadata.name,
                                icon: activity.tokenMetadata.icon || "",
                                network:
                                    activity.tokenMetadata.network || "near",
                            }}
                        />
                    )}

                    {/* Transaction Details */}
                    <InfoDisplay
                        hideSeparator
                        items={[
                            {
                                label: "Type",
                                value: isSwap
                                    ? "Swap"
                                    : isReceived
                                        ? "Received"
                                        : "Sent",
                            },
                            {
                                label: "Date",
                                value: (
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        includeTime
                                    />
                                ),
                            },
                            ...(isSwap
                                ? []
                                : [
                                    {
                                        label: "From",
                                        value: (
                                            <div className="flex items-center gap-1">
                                                <span className="max-w-[300px] truncate">
                                                    {fromAccount}
                                                </span>
                                                <CopyButton
                                                    text={fromAccount}
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    tooltipContent="Copy Address"
                                                    toastMessage="Address copied to clipboard"
                                                />
                                            </div>
                                        ),
                                    } as InfoItem,
                                    {
                                        label: "To",
                                        value: (
                                            <div className="flex items-center gap-1">
                                                <span className="max-w-[300px] truncate">
                                                    {toAccount}
                                                </span>
                                                <CopyButton
                                                    text={toAccount}
                                                    toastMessage="Address copied to clipboard"
                                                    tooltipContent="Copy Address"
                                                    variant="ghost"
                                                    size="icon-sm"
                                                />
                                            </div>
                                        ),
                                    } as InfoItem,
                                ]),
                            ...(isSwap && activity.swap?.sentTokenMetadata
                                ? [
                                    {
                                        label: "Sent",
                                        value: `${formatModalAmount(activity.swap!.sentAmount!, activity.swap!.sentTokenMetadata!.decimals, false)} ${activity.swap!.sentTokenMetadata!.symbol}`,
                                    } as InfoItem,
                                ]
                                : []),
                            ...(isSwap
                                ? [
                                    {
                                        label: "Received",
                                        value: `${formatModalAmount(activity.swap!.receivedAmount, activity.swap!.receivedTokenMetadata.decimals, false)} ${activity.swap!.receivedTokenMetadata.symbol}`,
                                    } as InfoItem,
                                ]
                                : []),
                            ...(isLoadingTransaction
                                ? [
                                    {
                                        label: "Transaction",
                                        value: (
                                            <Skeleton className="h-5 w-[200px]" />
                                        ),
                                    } as InfoItem,
                                ]
                                : transactionHash
                                    ? [
                                        {
                                            label: "Transaction",
                                            value: (
                                                <div className="flex items-center gap-2">
                                                    <span className="font-mono max-w-[200px] truncate">
                                                        {transactionHash}
                                                    </span>
                                                    <CopyButton
                                                        text={transactionHash}
                                                        toastMessage="Transaction hash copied to clipboard"
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        tooltipContent="Copy Transaction Hash"
                                                    />
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        tooltipContent="Open Link in Explorer"
                                                        onClick={() =>
                                                            openInExplorer(
                                                                transactionHash,
                                                            )
                                                        }
                                                    >
                                                        <ExternalLink className="h-3 w-3" />
                                                    </Button>
                                                </div>
                                            ),
                                        } as InfoItem,
                                    ]
                                    : []),
                        ]}
                    />
                </div>
            </DialogContent>
        </Dialog>
    );
}
