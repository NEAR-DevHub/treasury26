"use client";

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { MoveAssetsIcon } from "@/components/icons/move-assets";
import { useTreasury } from "@/hooks/use-treasury";
import { usePendingMoveRequests } from "../hooks/use-pending-move-requests";
import { usePublicAssets } from "../hooks/use-public-assets";
import { publicAssetKey } from "../utils/public-to-confidential";

const MIN_BANNER_USD = 1;

/**
 * Dashboard notice for a confidential treasury whose public account holds
 * funds. Hidden while loading, on error, and when nothing is detected.
 */
export function PublicBalanceBanner() {
    const t = useTranslations("moveAssets.banner");
    const { treasuryId } = useTreasury();
    const { data, isSuccess } = usePublicAssets();
    const tokens = data?.tokens ?? [];
    const pending = usePendingMoveRequests(tokens);

    if (
        !isSuccess ||
        !treasuryId ||
        tokens.length === 0 ||
        !data.totalBalanceUSD.gt(MIN_BANNER_USD)
    )
        return null;

    // Every asset already has an in-progress move request → point at it
    // (single request) or at the pending list instead of a second move.
    const allPending = tokens.every((asset) =>
        pending.has(publicAssetKey(asset)),
    );
    const pendingIds = [...new Set(pending.values())];
    const href = allPending
        ? pendingIds.length === 1
            ? `/${treasuryId}/requests/${pendingIds[0]}`
            : `/${treasuryId}/requests?tab=InProgress`
        : `/${treasuryId}/move-assets`;

    return (
        <div
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-general-border bg-general-tertiary p-4"
            data-testid="public-balance-banner"
        >
            <div className="space-y-0.5 min-w-0">
                <p className="text-sm font-medium text-foreground">
                    {t.rich("title", {
                        amount: () => (
                            <FormattedAmount
                                kind="fiat"
                                value={data?.totalBalanceUSD}
                            />
                        ),
                    })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t("description")}
                </p>
            </div>
            <Link
                href={href}
                className="shrink-0"
                data-testid="public-balance-move-button"
            >
                <Button className="w-full sm:w-auto h-8">
                    {allPending ? (
                        <>
                            {t("viewRequest")}
                            <Icon icon={ArrowRight01Icon} className="size-4" />
                        </>
                    ) : (
                        <>
                            <MoveAssetsIcon className="size-3.5" />
                            {t("moveAssets")}
                        </>
                    )}
                </Button>
            </Link>
        </div>
    );
}
