"use client";

import { ArrowRight01Icon, Coins02Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { MoveAssetsIcon } from "@/components/icons/move-assets";
import { StepperHeader } from "@/components/step-wizard";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { TableSkeleton } from "@/components/table-skeleton";
import { useTreasury } from "@/hooks/use-treasury";
import { decimalFromBaseUnits } from "@/lib/amount-format";
import type { TreasuryAsset } from "@/lib/api";
import { availableBalance } from "@/lib/balance";
import { publicAssetKey } from "../utils/public-to-confidential";

interface Props {
    tokens: TreasuryAsset[];
    isLoading: boolean;
    canMove: boolean;
    /** `publicAssetKey` → in-progress move request id (one request per asset). */
    pendingRequests: ReadonlyMap<string, number>;
    onMove: (asset: TreasuryAsset) => void;
}

/** "The funds that need to move" list: one Move Assets action per asset. */
export function PublicAssetsTable({
    tokens,
    isLoading,
    canMove,
    pendingRequests,
    onMove,
}: Props) {
    const t = useTranslations("moveAssets.list");
    const tTable = useTranslations("assetsTable");
    const { treasuryId } = useTreasury();

    const renderContent = () => {
        if (isLoading) return <TableSkeleton rows={2} />;
        if (tokens.length === 0) {
            return (
                <EmptyState
                    icon={Coins02Icon}
                    title={t("emptyTitle")}
                    description={t("emptyDescription")}
                />
            );
        }

        return (
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-0 sm:pl-4">
                            {t("token")}
                        </TableHead>
                        <TableHead className="text-right">
                            {tTable("balance")}
                        </TableHead>
                        <TableHead className="text-right hidden sm:table-cell">
                            {tTable("coinPrice")}
                        </TableHead>
                        <TableHead className="text-right" />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {tokens.map((asset) => {
                        const available = decimalFromBaseUnits(
                            availableBalance(asset.balance),
                            asset.decimals,
                        );
                        const pendingId = pendingRequests.get(
                            publicAssetKey(asset),
                        );
                        return (
                            <TableRow
                                key={publicAssetKey(asset)}
                                data-testid={`public-asset-row-${asset.id}`}
                            >
                                <TableCell className="py-4 pr-4 pl-0 sm:p-4 sm:pl-4 overflow-hidden">
                                    <div className="flex items-center gap-3 min-w-0">
                                        {/* biome-ignore lint/performance/noImgElement: remote token icons, same as assets-table */}
                                        <img
                                            src={asset.icon}
                                            alt={asset.name}
                                            className="h-8 w-8 shrink-0 rounded-full"
                                        />
                                        <div className="min-w-0">
                                            <p className="font-semibold truncate">
                                                {asset.symbol}
                                            </p>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {asset.name}
                                            </p>
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell className="p-4 text-right">
                                    <p className="font-semibold">
                                        <FormattedAmount
                                            kind="fiat"
                                            value={asset.balanceUSD}
                                        />
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        <FormattedAmount
                                            kind="token"
                                            value={available}
                                            symbol={asset.symbol}
                                            tokenDecimals={asset.decimals}
                                            unitPriceUsd={asset.price}
                                            profile="standard"
                                        />
                                    </p>
                                </TableCell>
                                <TableCell className="p-4 text-right hidden sm:table-cell">
                                    <FormattedAmount
                                        kind="unit-price"
                                        value={asset.price}
                                    />
                                </TableCell>
                                <TableCell className="p-4 text-right">
                                    {pendingId !== undefined ? (
                                        <Link
                                            href={`/${treasuryId}/requests/${pendingId}`}
                                            data-testid={`public-asset-view-${asset.id}`}
                                        >
                                            <Button
                                                type="button"
                                                size="sm"
                                                className="h-8"
                                            >
                                                {t("viewRequest")}
                                                <Icon
                                                    icon={ArrowRight01Icon}
                                                    className="size-4"
                                                />
                                            </Button>
                                        </Link>
                                    ) : (
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={!canMove}
                                            onClick={() => onMove(asset)}
                                            className="h-8"
                                            data-testid={`public-asset-move-${asset.id}`}
                                        >
                                            <MoveAssetsIcon className="size-3.5" />
                                            {t("moveAssets")}
                                        </Button>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        );
    };

    return (
        <PageCard className="flex flex-col gap-5">
            <StepperHeader title={t("title")} />
            {renderContent()}
        </PageCard>
    );
}
