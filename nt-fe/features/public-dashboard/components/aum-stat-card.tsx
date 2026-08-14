"use client";

import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { FormattedAmount } from "@/components/formatted-amount";
import { Skeleton } from "@/components/ui/skeleton";

interface AumStatCardProps {
    totalAumUsd: string;
    daoCount: number;
    snapshotDate: string;
}

function formatSnapshotDate(dateStr: string): string {
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

export function AumStatCard({
    totalAumUsd,
    daoCount,
    snapshotDate,
}: AumStatCardProps) {
    const t = useTranslations("publicDashboard");
    return (
        <PageCard>
            <div className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("assetsSecured")}
                </h3>
                <p className="text-3xl font-bold mt-2">
                    <FormattedAmount kind="fiat" value={totalAumUsd} />
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs text-muted-foreground">
                <span>
                    {t.rich("acrossDaos", {
                        count: daoCount,
                        bold: (chunks) => (
                            <span className="font-semibold text-foreground">
                                {chunks}
                            </span>
                        ),
                    })}
                </span>
                <span>
                    {t("updatedOn", { date: formatSnapshotDate(snapshotDate) })}
                </span>
            </div>
        </PageCard>
    );
}

export function AumStatCardSkeleton() {
    const t = useTranslations("publicDashboard");
    return (
        <PageCard>
            <div className="flex justify-around gap-4">
                <div className="flex-1">
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {t("assetsSecured")}
                    </h3>
                    <Skeleton className="h-9 w-48 mt-2" />
                </div>
            </div>
            <div className="flex gap-6">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-40" />
            </div>
        </PageCard>
    );
}
