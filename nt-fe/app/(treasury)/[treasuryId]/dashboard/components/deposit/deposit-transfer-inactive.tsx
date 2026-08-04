"use client";

import { History } from "lucide-react";
import { useTranslations } from "next-intl";

interface DepositTransferInactiveProps {
    pageTitle: string;
    badgeLabel: string;
}

export function DepositTransferInactive({
    pageTitle,
    badgeLabel,
}: DepositTransferInactiveProps) {
    const t = useTranslations("depositModal");

    return (
        <>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-3 pb-3 border-b border-general-border mb-3">
                <h1 className="font-semibold text-lg leading-snug">
                    {pageTitle}
                </h1>
                <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground px-2.5 py-1 text-xs font-medium shrink-0">
                    {badgeLabel}
                </span>
            </div>

            <div
                className="flex flex-col items-center justify-center text-center py-16 px-4"
                data-testid="deposit-transfer-inactive"
            >
                <div className="size-16 rounded-full bg-muted flex items-center justify-center mb-5">
                    <History className="size-7 text-muted-foreground" />
                </div>
                <h2 className="font-semibold text-base text-foreground">
                    {t("transfer.linkInactiveTitle")}
                </h2>
                <p className="text-sm text-muted-foreground mt-2 max-w-xs">
                    {t("transfer.linkInactiveDescription")}
                </p>
            </div>
        </>
    );
}
