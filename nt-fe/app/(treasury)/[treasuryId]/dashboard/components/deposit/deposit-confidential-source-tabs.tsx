"use client";

import { Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { NEAR_COM_ICON } from "@/constants/token";
import { cn } from "@/lib/utils";
import type { ConfidentialOrigin } from "./deposit-types";

interface DepositConfidentialSourceTabsProps {
    value: ConfidentialOrigin;
    onChange: (origin: ConfidentialOrigin) => void;
}

function NearComIcon({ className }: { className?: string }) {
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={NEAR_COM_ICON}
            alt=""
            width={20}
            height={20}
            className={cn(
                "size-4 sm:size-5 rounded-sm object-cover shrink-0",
                className,
            )}
        />
    );
}

function TrezuIcon({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                "size-4 sm:size-5 rounded-sm bg-brand-blue text-white flex items-center justify-center shrink-0",
                className,
            )}
        >
            <Zap className="size-2.5 sm:size-3 fill-current" />
        </span>
    );
}

export function DepositConfidentialSourceTabs({
    value,
    onChange,
}: DepositConfidentialSourceTabsProps) {
    const t = useTranslations("depositModal.confidentialOrigins");

    const tabs: {
        id: ConfidentialOrigin;
        fullLabel: string;
        icon: React.ReactNode;
    }[] = [
        {
            id: "trezu",
            fullLabel: t("trezu"),
            icon: <TrezuIcon />,
        },
        {
            id: "nearcom",
            fullLabel: t("nearcom"),
            icon: <NearComIcon />,
        },
    ];

    const shortLabel = t("short");

    return (
        <div className="flex gap-1 sm:gap-2 p-1 rounded-xl bg-muted min-w-0">
            {tabs.map((tab) => {
                const selected = value === tab.id;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onChange(tab.id)}
                        data-testid={`deposit-origin-${tab.id}`}
                        aria-label={tab.fullLabel}
                        className={cn(
                            "flex-1 min-w-0 flex items-center justify-center gap-1.5 sm:gap-2 rounded-lg px-1.5 py-1.5 sm:px-3 sm:py-2 text-xs sm:text-sm font-medium transition-colors",
                            selected
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {/* Large: icon left + full label. Small: short label + icon right. */}
                        <span className="hidden sm:inline-flex shrink-0">
                            {tab.icon}
                        </span>
                        <span className="truncate sm:hidden">{shortLabel}</span>
                        <span className="truncate hidden sm:inline">
                            {tab.fullLabel}
                        </span>
                        <span className="inline-flex shrink-0 sm:hidden">
                            {tab.icon}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
