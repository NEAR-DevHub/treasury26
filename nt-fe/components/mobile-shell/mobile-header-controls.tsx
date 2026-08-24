"use client";

import { ArrowDown01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { ConnectWalletButton } from "@/components/sign-in";
import { TreasuryLogo } from "@/components/treasury-info";
import { useTreasury } from "@/hooks/use-treasury";
import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useNear } from "@/stores/near-store";

export function MobileTreasuryHeaderButton() {
    const t = useTranslations("treasurySelector");
    const { config, treasuryId, isConfidential } = useTreasury();
    const openSheet = useMobileShellStore((state) => state.openSheet);
    const displayName = config ? (config.name ?? treasuryId) : t("select");

    return (
        <button
            type="button"
            id="dashboard-step5"
            onClick={() => openSheet("treasury")}
            className="flex min-w-0 items-center gap-2 rounded-xl py-1 pr-2 text-left"
            data-testid="mobile-treasury-trigger"
        >
            <TreasuryLogo
                logo={config?.metadata?.flagLogo}
                isConfidential={isConfidential ?? false}
                imageClassName="size-9 rounded-full"
                fallbackClassName="size-9 rounded-full bg-green-700"
                fallbackIconClassName="size-5 text-white"
            />
            <span className="min-w-0 truncate font-semibold text-foreground">
                {displayName}
            </span>
            <Icon
                icon={ArrowDown01Icon}
                className="size-4 shrink-0 text-muted-foreground"
            />
        </button>
    );
}

export function MobileUserHeaderButton() {
    const { accountId, isAuthenticated } = useNear();
    const openSheet = useMobileShellStore((state) => state.openSheet);

    if (!accountId || !isAuthenticated) {
        return <ConnectWalletButton iconOnly className="size-9 rounded-xl" />;
    }

    return (
        <button
            type="button"
            onClick={() => openSheet("user")}
            aria-label={accountId}
            className="flex size-9 items-center justify-center rounded-xl bg-green-600"
            data-testid="mobile-user-trigger"
        >
            <Icon icon={UserIcon} className="size-4 text-white" />
        </button>
    );
}
