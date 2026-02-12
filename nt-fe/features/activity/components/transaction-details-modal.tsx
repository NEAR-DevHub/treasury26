"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import { ExternalLink } from "lucide-react";
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

    const isReceived = parseFloat(activity.amount) > 0;
    const transactionType = isReceived ? "Payment received" : "Payment sent";

    // Determine From/To based on receiver_id vs treasury account
    const fromAccount = isReceived
        ? activity.counterparty || activity.signerId || "unknown"
        : treasuryId;

    const toAccount = isReceived
        ? treasuryId
        : activity.receiverId || activity.counterparty || "unknown";

    const formatAmount = (amount: string) => {
        const num = parseFloat(amount);
        const absNum = Math.abs(num);
        const sign = num >= 0 ? "+" : "-";

        const decimals =
            absNum >= 1 ? 2 : Math.min(6, activity.tokenMetadata.decimals);

        return `${sign}${absNum.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: decimals,
        })}`;
    };

    const transactionHash = activity.transactionHashes?.length
        ? activity.transactionHashes[0]
        : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    const openInExplorer = (hash: string) => {
        window.open(`https://nearblocks.io/txns/${hash}`, "_blank");
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[600px]">
                <DialogHeader className="border-b border-border">
                    <DialogTitle>Transaction Details</DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Transaction Summary */}
                    <AmountSummary
                        title={transactionType}
                        total={formatAmount(activity.amount)}
                        token={{
                            address: activity.tokenMetadata.tokenId,
                            symbol: activity.tokenMetadata.symbol,
                            decimals: activity.tokenMetadata.decimals,
                            name: activity.tokenMetadata.name,
                            icon: activity.tokenMetadata.icon || "",
                            network: activity.tokenMetadata.network || "near",
                        }}
                    />

                    {/* Transaction Details */}
                    <InfoDisplay
                        hideSeparator
                        items={[
                            {
                                label: "Type",
                                value: isReceived ? "Received" : "Sent",
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
                            },
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
                            },
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
                                                <div className="flex items-center">
                                                    <span className="font-mono max-w-[200px] truncate">
                                                        {transactionHash}
                                                    </span>

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
                                                    <CopyButton
                                                        text={transactionHash}
                                                        toastMessage="Transaction hash copied to clipboard"
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        tooltipContent="Copy Transaction Hash"
                                                    />
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
