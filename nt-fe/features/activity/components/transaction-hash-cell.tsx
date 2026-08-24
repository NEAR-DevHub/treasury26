"use client";

import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useReceiptSearch } from "@/hooks/use-receipt-search";
import { getExplorerTxUrl } from "@/lib/blockchain-utils";
import { cn } from "@/lib/utils";

const HASH_PREFIX_LENGTH = 6;
const HASH_SUFFIX_LENGTH = 9;

/** Middle-truncated so both ends of the hash stay recognisable in a cell. */
function truncateHash(hash: string) {
    if (hash.length <= HASH_PREFIX_LENGTH + HASH_SUFFIX_LENGTH) return hash;
    return `${hash.slice(0, HASH_PREFIX_LENGTH)}..${hash.slice(-HASH_SUFFIX_LENGTH)}`;
}

interface TransactionHashCellProps {
    transactionHashes?: string[];
    receiptIds?: string[];
    className?: string;
    chainName?: string | null;
}

/**
 * Reusable component for displaying transaction hash with receipt search fallback
 *
 * Displays a clickable transaction hash link with copy functionality.
 * If no transaction hash is provided, attempts to resolve it from receipt ID.
 * When chainName (from token metadata) is provided, it's used to pick the right
 * block explorer for the tx hash.
 */
export function TransactionHashCell({
    transactionHashes,
    receiptIds,
    className = "flex items-center justify-end gap-2",
    chainName,
}: TransactionHashCellProps) {
    const t = useTranslations("transactionHashCell");
    const needsReceiptSearch = !transactionHashes?.length;
    const { data: transactionFromReceipt, isLoading } = useReceiptSearch(
        needsReceiptSearch ? receiptIds?.[0] : undefined,
    );

    const transactionHash = transactionHashes?.length
        ? transactionHashes[0]
        : transactionFromReceipt?.[0]?.originatedFromTransactionHash;

    if (needsReceiptSearch && isLoading) {
        return <Skeleton className={cn("h-5 w-full", className)} />;
    }

    if (!transactionHash) return null;

    const explorerUrl = getExplorerTxUrl(chainName, transactionHash);

    return (
        <div className={className}>
            {explorerUrl ? (
                <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("openInExplorer")}
                    className="px-2 text-sm font-medium text-general-foreground underline"
                >
                    {truncateHash(transactionHash)}
                </a>
            ) : null}
            <CopyButton
                text={transactionHash}
                toastMessage={t("hashCopied")}
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
                tooltipContent={t("copyHash")}
            />
        </div>
    );
}
