"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { RecentActivity } from "@/lib/api";
import { FormattedDate } from "@/components/formatted-date";
import { CopyButton } from "@/components/copy-button";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { AmountSummary } from "@/components/amount-summary";
import { User } from "@/components/user";
import {
    useGetActivityLabel,
    useGetFromAccount,
    getToAccount,
} from "../utils/history-utils";
import { ExchangeSummaryCard } from "@/app/(treasury)/[treasuryId]/exchange/components/exchange-summary-card";
import { formatActivityAmount, formatSmartAmount } from "@/lib/utils";
import { TransactionHashCell } from "./transaction-hash-cell";
import { useTreasury } from "@/hooks/use-treasury";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

interface TransactionDetailsModalProps {
    activity: RecentActivity | null;
    treasuryId: string;
    isOpen: boolean;
    onClose: () => void;
}

function AccountValue({
    value,
    showCopy = true,
    useAddressBook = false,
}: {
    value: string;
    showCopy?: boolean;
    useAddressBook?: boolean;
}) {
    const t = useTranslations("activity.details");
    const canRenderUser =
        useAddressBook &&
        value !== "via NEAR Intents" &&
        value !== "N/A" &&
        value !== "Confidential" &&
        value !== "unknown" &&
        value !== "UNKNOWN" &&
        !value.includes(" ");

    if (canRenderUser) {
        return <User accountId={value} useAddressBook withHoverCard={true} />;
    }

    return (
        <div className="flex items-center gap-1">
            <span className="max-w-[300px] truncate">{value}</span>
            {showCopy && value !== "N/A" && value !== "Confidential" ? (
                <CopyButton
                    text={value}
                    variant="ghost"
                    size="icon-sm"
                    tooltipContent={t("copyAddress")}
                    toastMessage={t("addressCopied")}
                />
            ) : null}
        </div>
    );
}

export function TransactionDetailsModal({
    activity,
    treasuryId,
    isOpen,
    onClose,
}: TransactionDetailsModalProps) {
    const t = useTranslations("activity.details");
    const getActivityLabel = useGetActivityLabel();
    const getFromAccount = useGetFromAccount();
    const { isConfidential } = useTreasury();
    if (!activity) return null;

    const isReceived = parseFloat(activity.amount) > 0;
    const isSwap = !!activity.swap;
    const isFunctionCall = activity.actionKind === "FunctionCall";
    const transactionType = getActivityLabel({
        ...activity,
        tokenSymbol: activity.tokenMetadata?.symbol,
    });

    const fromAccount = getFromAccount(
        activity,
        isReceived,
        treasuryId,
        isConfidential,
    );
    const toAccount = getToAccount(
        activity,
        isReceived,
        treasuryId,
        isConfidential,
    );

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[600px]">
                <DialogHeader className="border-b border-border">
                    <DialogTitle>{t("title")}</DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Transaction Summary */}
                    {isSwap && activity.swap ? (
                        <div className="relative flex justify-center items-center gap-4 w-full">
                            {/* From: Sent Token */}
                            {activity.swap.sentAmount &&
                            activity.swap.sentTokenMetadata ? (
                                <ExchangeSummaryCard
                                    title={t("sell")}
                                    token={{
                                        address:
                                            activity.swap.sentTokenMetadata
                                                .tokenId,
                                        symbol: activity.swap.sentTokenMetadata
                                            .symbol,
                                        decimals:
                                            activity.swap.sentTokenMetadata
                                                .decimals,
                                        name: activity.swap.sentTokenMetadata
                                            .name,
                                        icon:
                                            activity.swap.sentTokenMetadata
                                                .icon || "",
                                        network:
                                            activity.swap.sentTokenMetadata
                                                .network || NEAR_NETWORK_ID,
                                        chainIcons:
                                            activity.swap.sentTokenMetadata
                                                .chainIcons,
                                    }}
                                    amount={formatSmartAmount(
                                        activity.swap.sentAmount,
                                    )}
                                />
                            ) : null}

                            {/* Arrow - absolutely positioned */}
                            <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                                <div className="rounded-full bg-card border p-1.5 shadow-sm">
                                    <ChevronRight className="size-6 text-muted-foreground" />
                                </div>
                            </div>

                            {/* To: Received Token */}
                            <ExchangeSummaryCard
                                title={t("receive")}
                                token={{
                                    address:
                                        activity.swap.receivedTokenMetadata
                                            .tokenId,
                                    symbol: activity.swap.receivedTokenMetadata
                                        .symbol,
                                    decimals:
                                        activity.swap.receivedTokenMetadata
                                            .decimals,
                                    name: activity.swap.receivedTokenMetadata
                                        .name,
                                    icon:
                                        activity.swap.receivedTokenMetadata
                                            .icon || "",
                                    network:
                                        activity.swap.receivedTokenMetadata
                                            .network || NEAR_NETWORK_ID,
                                    chainIcons:
                                        activity.swap.receivedTokenMetadata
                                            .chainIcons,
                                }}
                                amount={
                                    activity.swap.receivedAmount
                                        ? formatSmartAmount(
                                              activity.swap.receivedAmount,
                                          )
                                        : t("pending")
                                }
                            />
                        </div>
                    ) : (
                        <AmountSummary
                            title={transactionType}
                            total={formatActivityAmount(activity.amount)}
                            preserveFormattedTotal
                            showNetworkIcon
                            token={{
                                address: activity.tokenMetadata.tokenId,
                                symbol: activity.tokenMetadata.symbol,
                                decimals: activity.tokenMetadata.decimals,
                                name: activity.tokenMetadata.name,
                                icon: activity.tokenMetadata.icon || "",
                                network:
                                    activity.tokenMetadata.network ||
                                    NEAR_NETWORK_ID,
                                chainIcons: activity.tokenMetadata.chainIcons,
                            }}
                        />
                    )}

                    {/* Transaction Details */}
                    <InfoDisplay
                        hideSeparator
                        items={[
                            {
                                label: t("type"),
                                value: transactionType,
                            },
                            {
                                label: t("date"),
                                value: (
                                    <FormattedDate
                                        date={new Date(activity.blockTime)}
                                        includeTime
                                    />
                                ),
                            },
                            ...(activity.proposalId != null
                                ? [
                                      {
                                          label: t("request"),
                                          value: (
                                              <Link
                                                  href={`/${treasuryId}/requests/${activity.proposalId}`}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="text-primary underline"
                                              >
                                                  #{activity.proposalId}
                                              </Link>
                                          ),
                                      } as InfoItem,
                                  ]
                                : []),
                            ...(isSwap && activity.swap
                                ? [
                                      {
                                          label: t("from"),
                                          value: (
                                              <AccountValue
                                                  value={fromAccount}
                                                  showCopy={false}
                                                  useAddressBook
                                              />
                                          ),
                                      } as InfoItem,
                                      {
                                          label: t("to"),
                                          value: (
                                              <AccountValue
                                                  value={toAccount}
                                                  useAddressBook
                                              />
                                          ),
                                      } as InfoItem,
                                  ]
                                : isFunctionCall && activity.methodName
                                  ? [
                                        {
                                            label: t("method"),
                                            value: activity.methodName,
                                        } as InfoItem,
                                        {
                                            label: t("contract"),
                                            value: (
                                                <AccountValue
                                                    value={
                                                        activity.receiverId ||
                                                        activity.counterparty ||
                                                        "N/A"
                                                    }
                                                    useAddressBook
                                                />
                                            ),
                                        } as InfoItem,
                                    ]
                                  : [
                                        {
                                            label: t("from"),
                                            value: (
                                                <AccountValue
                                                    value={fromAccount}
                                                    useAddressBook
                                                />
                                            ),
                                        } as InfoItem,
                                        {
                                            label: t("to"),
                                            value: (
                                                <AccountValue
                                                    value={toAccount}
                                                    useAddressBook
                                                />
                                            ),
                                        } as InfoItem,
                                    ]),
                            ...(activity.transactionHashes?.length ||
                            activity.receiptIds?.length
                                ? [
                                      {
                                          label: t("transaction"),
                                          value: (
                                              <TransactionHashCell
                                                  transactionHashes={
                                                      activity.transactionHashes
                                                  }
                                                  receiptIds={
                                                      activity.receiptIds
                                                  }
                                                  className="flex items-center gap-2"
                                              />
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
