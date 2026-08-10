"use client";

import { useTranslations } from "next-intl";
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
        disabled?: boolean;
    }[] = [
        {
            id: "public_wallet",
            title: t("publicWallet.title"),
            subtitle: t("publicWallet.subtitle"),
            disabled: disablePublicWallet,
        },
        {
            id: "confidential_user",
            title: t("confidentialUser.title"),
            subtitle: t("confidentialUser.subtitle"),
        },
    ];

    return (
        <div className="grid gap-3 md:grid-cols-2 mb-2">
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
                            "h-full rounded-xl border border-general-border p-3 md:p-4 text-left transition hover:bg-muted/70",
                            selected ? "bg-general-tertiary" : "",
                            card.disabled && "opacity-50 cursor-not-allowed",
                        )}
                    >
                        <div className="flex h-full items-start justify-between gap-3">
                            <div className="space-y-1">
                                <p className="text-sm font-semibold">
                                    {card.title}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {card.subtitle}
                                </p>
                            </div>
                            <div className="self-start size-5 min-h-5 min-w-5 shrink-0 rounded-full border-2 border-general-unofficial-border-3 flex items-center justify-center">
                                {selected && (
                                    <div className="size-2.5 rounded-full bg-foreground" />
                                )}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}
