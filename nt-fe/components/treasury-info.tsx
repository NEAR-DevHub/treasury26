"use client";

import { Database } from "lucide-react";
import { useAssets } from "@/hooks/use-assets";
import { cn, formatCurrency } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

export function TreasuryLogo({ logo }: { logo?: string }) {
    if (logo) {
        return (
            <img
                src={logo}
                alt="Treasury Logo"
                className="rounded-md size-7 shrink-0 object-cover"
            />
        );
    }
    return (
        <div className="flex items-center justify-center size-7 rounded bg-muted shrink-0">
            <Database className="size-5 text-muted-foreground" />
        </div>
    );
}

export function TreasuryBalance({
    daoId,
    className,
    skeletonClassName,
}: {
    daoId: string;
    className?: string;
    skeletonClassName?: string;
}) {
    const { data, isLoading } = useAssets(daoId);
    if (isLoading)
        return <Skeleton className={skeletonClassName ?? "h-4 w-16"} />;
    if (data?.totalBalanceUSD === undefined) return null;
    return (
        <span className={cn("text-sm text-muted-foreground", className)}>
            {formatCurrency(Number(data.totalBalanceUSD))}
        </span>
    );
}
