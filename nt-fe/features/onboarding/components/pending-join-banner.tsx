"use client";

import { Clock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMyMemberJoinStatus } from "@/hooks/use-member-invites";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";

export function PendingJoinBanner() {
    const t = useTranslations("onboarding.pendingJoinBanner");
    const { accountId } = useNear();
    const { treasuryId, isGuestTreasury, isLoading } = useTreasury();
    const { data, isLoading: isStatusLoading } = useMyMemberJoinStatus(
        treasuryId,
        !!accountId && !!isGuestTreasury,
    );

    if (
        isLoading ||
        isStatusLoading ||
        !accountId ||
        !isGuestTreasury ||
        data?.status !== "pending"
    ) {
        return null;
    }

    return (
        <div className="flex items-start gap-3 rounded-xl border border-general-border bg-general-tertiary p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-general-orange-background-faded">
                <Clock className="size-4 text-general-orange-foreground" />
            </div>
            <div className="space-y-0.5 min-w-0">
                <p className="text-sm font-semibold text-foreground">
                    {t("title")}
                </p>
                <p className="text-sm text-muted-foreground">
                    {t("description")}
                </p>
            </div>
        </div>
    );
}
