"use client";

import { Globe02Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import type { DepositSource } from "./deposit-types";

interface DepositSourceCardsProps {
    value: DepositSource;
    onChange: (source: DepositSource) => void;
    disablePublicWallet?: boolean;
}

export function DepositSourceCards({
    value,
    onChange,
    disablePublicWallet = false,
}: DepositSourceCardsProps) {
    const t = useTranslations("depositModal.sourceCards");

    const cards: {
        id: DepositSource;
        title: string;
        subtitle: string;
        icon: typeof Globe02Icon;
        disabled?: boolean;
    }[] = [
        {
            id: "public_wallet",
            title: t("publicWallet.title"),
            subtitle: t("publicWallet.subtitle"),
            icon: Globe02Icon,
            disabled: disablePublicWallet,
        },
        {
            id: "confidential_user",
            title: t("confidentialUser.title"),
            subtitle: t("confidentialUser.subtitle"),
            icon: Shield01Icon,
        },
    ];

    return (
        <div className="mb-2 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
            {cards.map((card) => {
                const selected = value === card.id;
                return (
                    <button
                        key={card.id}
                        type="button"
                        disabled={card.disabled}
                        onClick={() => onChange(card.id)}
                        data-testid={`deposit-source-${card.id}`}
                        className={cn(
                            "flex h-full items-start justify-between gap-2 rounded-2xl border border-general-border bg-card p-3 text-left transition hover:bg-muted/50 md:p-4",
                            card.disabled && "cursor-not-allowed opacity-50",
                        )}
                    >
                        <div className="flex min-w-0 flex-1 items-start gap-2">
                            <Icon
                                icon={card.icon}
                                className="mt-0.5 size-5 shrink-0"
                            />
                            <div className="min-w-0">
                                <p className="text-base font-semibold leading-[120%] text-foreground">
                                    {card.title}
                                </p>
                                <p className="mt-0.5 text-sm font-medium leading-[150%] text-muted-foreground">
                                    {card.subtitle}
                                </p>
                            </div>
                        </div>
                        <span
                            aria-hidden="true"
                            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-general-unofficial-border-3"
                        >
                            {selected && (
                                <span className="size-2.5 rounded-full bg-foreground" />
                            )}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
