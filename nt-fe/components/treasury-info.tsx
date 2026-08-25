"use client";

import { Icon } from "@/components/icon";
import { DatabaseIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { useAssets } from "@/hooks/use-assets";
import { cn, formatCurrency } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

function normalizeFlagLogoUrl(
    logo: string | null | undefined,
): string | undefined {
    if (!logo) return undefined;

    const trimmedLogo = logo.trim();
    if (!trimmedLogo) return undefined;

    if (/^https?:\/\//i.test(trimmedLogo)) return trimmedLogo;

    const normalized = trimmedLogo
        .replace(/^ipfs:\/\//i, "")
        .replace(/^\/?ipfs\//i, "")
        .replace(/^\/+/, "");

    const isCidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(normalized);
    const isCidV1 = /^bafy[a-z2-7]{55,}$/.test(normalized);
    if (!isCidV0 && !isCidV1) return undefined;

    return `https://ipfs.near.social/ipfs/${normalized}`;
}

export function TreasuryLogo({
    logo,
    isConfidential: _isConfidential,
    alt,
    imageClassName,
    fallbackClassName,
    fallbackIconClassName,
}: {
    logo?: string | null;
    isConfidential?: boolean;
    alt?: string;
    imageClassName?: string;
    fallbackClassName?: string;
    fallbackIconClassName?: string;
}) {
    const t = useTranslations("treasuryInfo");
    const [hasImageError, setHasImageError] = useState(false);
    const normalizedLogoUrl = useMemo(() => normalizeFlagLogoUrl(logo), [logo]);

    useEffect(() => {
        setHasImageError(false);
    }, [normalizedLogoUrl]);

    const shouldShowImage = !!normalizedLogoUrl && !hasImageError;
    const logoAlt = alt ?? t("logoAlt");

    return (
        <div className="relative">
            {shouldShowImage ? (
                <img
                    src={normalizedLogoUrl}
                    alt={logoAlt}
                    className={cn(
                        "rounded-md size-7 shrink-0 object-cover",
                        imageClassName,
                    )}
                    onError={() => setHasImageError(true)}
                />
            ) : (
                <div
                    className={cn(
                        "flex items-center justify-center size-7 rounded bg-muted shrink-0",
                        fallbackClassName,
                    )}
                >
                    <Icon
                        icon={DatabaseIcon}
                        className={cn(
                            "text-muted-foreground",
                            fallbackIconClassName,
                        )}
                    />
                </div>
            )}
        </div>
    );
}

export function TreasuryBalance({
    daoId,
    isConfidential,
    className,
    skeletonClassName,
}: {
    daoId: string;
    isConfidential?: boolean;
    className?: string;
    skeletonClassName?: string;
}) {
    const isMasked = useIsBalanceMasked();
    const { data, isLoading } = useAssets(daoId, { enabled: !isConfidential });

    if (isConfidential || isMasked)
        return (
            <span className={cn("text-sm text-muted-foreground", className)}>
                {BALANCE_MASK}
            </span>
        );
    if (isLoading)
        return <Skeleton className={skeletonClassName ?? "h-4 w-16"} />;
    if (!data?.tokens) return null;
    const totalBalance = data.tokens.reduce((sum, t) => sum + t.balanceUSD, 0);
    return (
        <span className={cn("text-sm text-muted-foreground", className)}>
            {formatCurrency(totalBalance)}
        </span>
    );
}
