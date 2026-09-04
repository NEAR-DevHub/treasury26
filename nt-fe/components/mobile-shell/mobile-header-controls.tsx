"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { ProfileAvatarChip } from "@/components/profile-avatar-chip";
import { ConnectWalletButton } from "@/components/sign-in";
import { TreasuryBalance, TreasuryLogo } from "@/components/treasury-info";
import { useTreasury } from "@/hooks/use-treasury";
import { useProfile } from "@/hooks/use-treasury-queries";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useNear } from "@/stores/near-store";

export function MobileTreasuryHeaderButton() {
    const t = useTranslations("treasurySelector");
    const { config, treasuryId, isConfidential, isGuestTreasury } =
        useTreasury();
    const openSheet = useMobileShellStore((state) => state.openSheet);
    const displayName = config ? (config.name ?? treasuryId) : t("select");

    return (
        <button
            type="button"
            id="dashboard-step5"
            onClick={() => openSheet("treasury")}
            className="flex min-w-0 max-w-[11rem] items-center gap-2 rounded-xl py-1 pr-2 text-left"
            data-testid="mobile-treasury-trigger"
        >
            <TreasuryLogo
                logo={config?.metadata?.flagLogo}
                isConfidential={isConfidential ?? false}
                imageClassName="size-9 shrink-0 rounded-full"
                fallbackClassName="size-9 shrink-0 rounded-full bg-green-700"
                fallbackIconClassName="size-5 text-white"
            />
            <div className="flex min-w-0 flex-1 flex-col items-start">
                <span className="w-full truncate font-semibold leading-tight text-foreground">
                    {displayName}
                </span>
                {treasuryId ? (
                    // Same privacy contract as desktop TreasurySelector: members
                    // see balances on confidential treasuries; guests get a mask.
                    <TreasuryBalance
                        daoId={treasuryId}
                        className="w-full truncate text-xs font-medium leading-tight text-muted-foreground"
                        skeletonClassName="h-3 w-16"
                        isConfidential={isConfidential && isGuestTreasury}
                    />
                ) : null}
            </div>
            <Icon
                icon={ArrowDown01Icon}
                className="size-4 shrink-0 text-muted-foreground"
            />
        </button>
    );
}

export function MobileUserHeaderButton() {
    const { accountId, isAuthenticated } = useNear();
    const { data: profile } = useProfile(accountId);
    const openSheet = useMobileShellStore((state) => state.openSheet);

    if (!accountId || !isAuthenticated) {
        return <ConnectWalletButton iconOnly className="size-9 rounded-xl" />;
    }

    const displayName =
        profile?.name && profile.name !== accountId ? profile.name : accountId;

    return (
        <button
            type="button"
            data-tour-help-support=""
            onClick={() => openSheet("user")}
            aria-label={accountId}
            className="flex size-9 items-center justify-center"
            data-testid="mobile-user-trigger"
        >
            <ProfileAvatarChip
                imageUrl={resolveProfileImageUrl(profile?.image)}
                name={displayName}
                variant="large"
            />
        </button>
    );
}
