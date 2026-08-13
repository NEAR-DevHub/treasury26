"use client";

import { Coins } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { FormattedAmount } from "@/components/formatted-amount";
import { StepperHeader } from "@/components/step-wizard";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { PublicDashboardToken } from "../api";

interface TopTokensTableProps {
    tokens: PublicDashboardToken[];
}

function TokenIcon({ icon, symbol }: { icon: string | null; symbol: string }) {
    const isImage =
        icon &&
        (icon.startsWith("data:image") ||
            icon.startsWith("http") ||
            icon.startsWith("/"));

    if (isImage) {
        return (
            <img
                src={icon}
                alt={symbol}
                className="h-10 w-10 rounded-full shrink-0"
            />
        );
    }

    return (
        <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-xl shrink-0 text-white font-semibold">
            {symbol.charAt(0).toUpperCase()}
        </div>
    );
}

export function TopTokensTable({ tokens }: TopTokensTableProps) {
    const t = useTranslations("publicDashboard");
    return (
        <PageCard className="p-0 gap-0 overflow-hidden">
            <div className="px-4 pt-4 pb-2">
                <StepperHeader title={t("topAssets")} />
            </div>

            {tokens.length === 0 ? (
                <div className="px-4 pb-4">
                    <EmptyState
                        icon={Coins}
                        title={t("noAssetsTitle")}
                        description={t("noAssetsDescription")}
                    />
                </div>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10 pl-4 text-center">
                                #
                            </TableHead>
                            <TableHead>{t("tableToken")}</TableHead>
                            <TableHead className="pr-4 text-right">
                                {t("tableTotalValue")}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {tokens.map((token) => (
                            <TableRow key={token.tokenId}>
                                <TableCell className="pl-4 text-center text-sm text-muted-foreground tabular-nums">
                                    {token.rank}
                                </TableCell>

                                <TableCell>
                                    <div className="flex items-center gap-3">
                                        <TokenIcon
                                            icon={token.icon}
                                            symbol={token.symbol}
                                        />
                                        <div>
                                            <p className="font-semibold">
                                                {token.symbol}
                                            </p>
                                            <p className="text-sm text-muted-foreground">
                                                {token.name}
                                            </p>
                                        </div>
                                    </div>
                                </TableCell>

                                <TableCell className="pr-4 text-right font-semibold tabular-nums">
                                    <FormattedAmount
                                        kind="fiat"
                                        value={token.totalUsd}
                                    />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </PageCard>
    );
}

export function TopTokensTableSkeleton() {
    return (
        <PageCard className="p-0 gap-0 overflow-hidden">
            <div className="px-4 pt-4 pb-2">
                <Skeleton className="h-5 w-24" />
            </div>
            <div className="divide-y divide-border">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <Skeleton className="size-5 w-10 rounded" />
                        <Skeleton className="size-10 rounded-full shrink-0" />
                        <div className="flex-1 space-y-1.5">
                            <Skeleton className="h-4 w-16" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-4 w-24" />
                    </div>
                ))}
            </div>
        </PageCard>
    );
}
