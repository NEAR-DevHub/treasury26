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
        src: "https://s2.coinmarketcap.com/static/img/coins/128x128/825.png",
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
                <p className="text-xl font-semibold leading-[1.2] tracking-[-0.025rem] text-foreground">
                    {t("fundTitle")}
                </p>
                <p className="text-sm font-medium leading-normal text-muted-foreground">
                    {t("fundDescription")}
                </p>
            </div>
            <Button
                id="dashboard-step1"
                className="rounded-full"
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
                            width={32}
                            height={32}
                            className={cn(
                                "size-8 rounded-full border-2 border-card object-cover",
                                index > 0 && "-ml-2",
                            )}
                        />
                    ))}
                </div>
                <p className="text-left text-sm font-medium leading-snug text-muted-foreground whitespace-pre-wrap">
                    {t("fundAssetsHint")}
                </p>
            </div>
        </div>
    );
}
