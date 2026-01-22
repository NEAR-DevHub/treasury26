"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/modal";
import { Button } from "@/components/button";
import { ExternalLink } from "lucide-react";
import type { RecentActivity } from "@/lib/api";
import { FormattedDate } from "@/components/formatted-date";
import { CopyButton } from "@/components/copy-button";

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

  const isReceived = parseFloat(activity.amount) > 0;
  const transactionType = isReceived ? "Payment received" : "Payment sent";

  // Determine From/To based on receiver_id vs treasury account
  const fromAccount = isReceived
    ? activity.counterparty || activity.signer_id || "unknown"
    : treasuryId;

  const toAccount = isReceived
    ? treasuryId
    : activity.receiver_id || activity.counterparty || "unknown";

  const formatAmount = (amount: string) => {
    const num = parseFloat(amount);
    const absNum = Math.abs(num);
    const sign = num >= 0 ? "+" : "-";

    const decimals = absNum >= 1 ? 2 : Math.min(6, activity.token_metadata.decimals);

    return `${sign}${absNum.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimals,
    })}`;
  };

  const openInExplorer = (txHash: string) => {
    window.open(`https://nearblocks.io/txns/${txHash}`, '_blank');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px] bg-sidebar">
        <DialogHeader>
          <DialogTitle>Transaction Details</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Transaction Summary */}
          <div className="bg-muted rounded-lg flex flex-col items-center justify-center space-y-1 py-6">
            <p className="text-sm text-muted-foreground font-medium">{transactionType}</p>

            {activity.token_metadata.icon && (
              <div className="w-16 h-16 rounded-full bg-background flex items-center justify-center border-2">
                <img
                  src={activity.token_metadata.icon}
                  alt={activity.token_metadata.symbol}
                  width={48}
                  height={48}
                  className="rounded-full"
                />
              </div>
            )}

            <div className="flex items-center gap-1 justify-center">
              <span className="text-2xl font-bold text-general">{formatAmount(activity.amount)}</span>
              <span className="text-muted-foreground text-md">{activity.token_metadata.symbol}</span>
            </div>
          </div>

          {/* Transaction Details */}
          <div className="space-y-2">
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">Type</span>
              <span className="text-sm capitalize">{isReceived ? "Received" : "Sent"}</span>
            </div>

            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">Date</span>
              <span className="text-sm ">
                <FormattedDate date={new Date(activity.block_time)} includeTime />
              </span>
            </div>

            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">From</span>
              <div className="flex items-center gap-1">
                <span className="text-sm max-w-[300px] truncate">
                  {fromAccount}
                </span>
                <CopyButton
                  text={fromAccount}
                  toastMessage="Address copied to clipboard"
                  className="h-6 w-6 p-0"
                  iconClassName="h-3 w-3 text-muted-foreground"
                  variant="unstyled"
                />
              </div>
            </div>

            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">To</span>
              <div className="flex items-center gap-1">
                <span className="text-sm max-w-[300px] truncate">
                  {toAccount}
                </span>
                <CopyButton
                  text={toAccount}
                  toastMessage="Address copied to clipboard"
                  className="h-6 w-6 p-0"
                  iconClassName="h-3 w-3 text-muted-foreground"
                  variant="unstyled"
                />
              </div>
            </div>

            {activity.transaction_hashes.length > 0 && (
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-muted-foreground">Transaction</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono max-w-[200px] truncate">
                    {activity.transaction_hashes[0]}
                  </span>
                  <CopyButton
                    text={activity.transaction_hashes[0]}
                    toastMessage="Transaction hash copied to clipboard"
                    className="h-6 w-6 p-0"
                    iconClassName="h-3 w-3 text-muted-foreground"
                    variant="unstyled"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => openInExplorer(activity.transaction_hashes[0])}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

