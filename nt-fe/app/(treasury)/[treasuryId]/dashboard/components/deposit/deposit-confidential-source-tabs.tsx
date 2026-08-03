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
            className={cn("size-5 rounded-md shrink-0", className)}
        />
    );
}

function TrezuIcon({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                "size-5 rounded-md bg-brand-blue text-white flex items-center justify-center shrink-0",
                className,
            )}
        >
            <Zap className="size-3 fill-current" />
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
        label: string;
        icon: React.ReactNode;
    }[] = [
        {
            id: "trezu",
            label: t("trezu"),
            icon: <TrezuIcon />,
        },
        {
            id: "nearcom",
            label: t("nearcom"),
            icon: <NearComIcon />,
        },
    ];

    return (
        <div className="flex gap-2 p-1 rounded-xl bg-muted">
            {tabs.map((tab) => {
                const selected = value === tab.id;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onChange(tab.id)}
                        data-testid={`deposit-origin-${tab.id}`}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                            selected
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {tab.icon}
                        <span className="truncate">{tab.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
