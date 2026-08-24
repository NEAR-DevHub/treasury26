"use client";

import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const FEATURED_TOKEN_ICONS = [
    {
        src: "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png",
        alt: "NEAR",
    },
    {
        src: "https://near.com/static/icons/network/usdt.png",
        alt: "USDT",
    },
    {
        src: "https://s2.coinmarketcap.com/static/img/coins/128x128/3408.png",
        alt: "USDC",
    },
] as const;

interface Props {
    onReceiveClick: () => void;
}

export function FundAccountEmpty({ onReceiveClick }: Props) {
    const t = useTranslations("balanceWithGraph");
    const { treasuryId } = useTreasury();

    return (
        <div
            className="flex flex-col items-center justify-center gap-5 py-12 text-center"
            data-testid="fund-account-empty"
        >
            <div className="flex flex-col items-center gap-0.5">
                <p className="text-center text-xl font-semibold leading-[1.2] tracking-[-0.025rem] text-general-foreground">
                    {t("fundTitle")}
                </p>
                <p className="text-center text-base font-medium leading-[1.5] text-muted-foreground">
                    {t("fundDescription")}
                </p>
            </div>
            <Button
                id="dashboard-step1"
                className="h-11 gap-2 rounded-2xl px-6"
                onClick={() => {
                    trackEvent("nav-click", {
                        destination: "deposit",
                        source: "dashboard",
                        treasury_id: treasuryId,
                    });
                    onReceiveClick();
                }}
            >
                <Icon icon={ArrowDown02Icon} />
                {t("receive")}
            </Button>
            <div className="flex items-center gap-2.5">
                <div className="flex items-center">
                    {FEATURED_TOKEN_ICONS.map((token, index) => (
                        <img
                            key={token.alt}
                            src={token.src}
                            alt={token.alt}
                            width={28}
                            height={28}
                            referrerPolicy="no-referrer"
                            className={cn(
                                "size-9 rounded-full border-2 border-card object-cover",
                                index > 0 && "-ml-2",
                            )}
                        />
                    ))}
                </div>
                <p className="whitespace-pre-wrap text-left text-xs font-normal leading-4 tracking-[0.01125rem] text-muted-foreground">
                    {t("fundAssetsHint")}
                </p>
            </div>
        </div>
    );
}
