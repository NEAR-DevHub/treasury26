"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ConfidentialDepositOrigin } from "./deposit-types";

interface DepositOriginTabsProps {
    value: ConfidentialDepositOrigin;
    onChange: (origin: ConfidentialDepositOrigin) => void;
    className?: string;
}

const TABS: {
    id: ConfidentialDepositOrigin;
    labelKey: "fromNearBusiness" | "fromConfidentialNearcom";
}[] = [
    { id: "near_business", labelKey: "fromNearBusiness" },
    { id: "nearcom", labelKey: "fromConfidentialNearcom" },
];

export function DepositOriginTabs({
    value,
    onChange,
    className,
}: DepositOriginTabsProps) {
    const t = useTranslations("depositModal.tabs");

    return (
        // A pair of mutually exclusive choices rather than real tabs: the
        // content they switch lives in a sibling component, so `tablist`
        // would promise a tabpanel and arrow-key navigation that don't exist.
        <fieldset
            className={cn(
                "m-0 grid min-w-0 grid-cols-2 gap-0.5 rounded-full border border-general-border bg-general-bg-secondary p-0.5 sm:gap-1 sm:p-1",
                className,
            )}
        >
            <legend className="sr-only">{t("originLabel")}</legend>
            {TABS.map((tab) => {
                const selected = value === tab.id;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        aria-pressed={selected}
                        data-testid={`deposit-origin-tab-${tab.id}`}
                        onClick={() => onChange(tab.id)}
                        className={cn(
                            "min-w-0 rounded-full px-1.5 py-1.5 text-center text-xs font-semibold leading-tight whitespace-nowrap transition sm:px-3 sm:py-2 sm:text-sm",
                            selected
                                ? "border border-general-border bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {t(tab.labelKey)}
                    </button>
                );
            })}
        </fieldset>
    );
}
