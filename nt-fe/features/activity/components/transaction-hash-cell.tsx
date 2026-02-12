"use client";

import { CopyButton } from "@/components/copy-button";
import { useReceiptSearch } from "@/hooks/use-receipt-search";

interface TransactionHashCellProps {
    transactionHashes?: string[];
    receiptIds?: string[];
    className?: string;
}

/**
 * Reusable component for displaying transaction hash with receipt search fallback
 * 
 * Displays a clickable transaction hash link with copy functionality.
 * If no transaction hash is provided, attempts to resolve it from receipt ID.
 */
export function TransactionHashCell({
    transactionHashes,
    receiptIds,
    className = "flex items-center justify-end gap-2",
}: TransactionHashCellProps) {
    const needsReceiptSearch = !transactionHashes?.length;
    const { data: transactionFromReceipt } = useReceiptSearch(
        needsReceiptSearch ? receiptIds?.[0] : undefined,
    );

    const transactionHash = transactionHashes?.length
        ? transactionHashes[0]
        : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    if (!transactionHash) return null;

    return (
        <div className={className}>
            <a
                href={`https://nearblocks.io/txns/${transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline hover:no-underline"
            >
                {transactionHash.slice(0, 12)}...
            </a>
            <CopyButton
                text={transactionHash}
                toastMessage="Transaction hash copied"
                className="h-6 w-6 p-0"
                iconClassName="h-3 w-3"
                variant="ghost"
            />
        </div>
    );
}

