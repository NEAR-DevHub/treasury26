"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { NearBusinessLogo } from "@/components/icons/near-business-logo";
import { useTreasury } from "@/hooks/use-treasury";
import { resolveTreasuryHomeHref } from "@/lib/treasury-home";

/**
 * Shown when a signed-in user opens a treasury they do not belong to.
 * Guest browsing is no longer allowed — this replaces guest mode for shell routes.
 */
export function NotMemberScreen() {
    const t = useTranslations("notMemberScreen");
    const router = useRouter();
    const { lastTreasuryId, memberTreasuries } = useTreasury();

    const handleBackToHome = () => {
        router.push(resolveTreasuryHomeHref(memberTreasuries, lastTreasuryId));
    };

    return (
        <div className="flex min-h-dvh flex-col items-center bg-general-bg-tertiary px-4 py-10">
            <NearBusinessLogo className="h-7 w-auto" />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-16 text-center">
                <h1 className="max-w-md text-2xl font-bold leading-[1.2] text-general-foreground">
                    {t("title")}
                </h1>
                <p className="max-w-sm text-base font-medium leading-[150%] text-general-secondary-foreground">
                    {t("description")}
                </p>
                <Button
                    type="button"
                    onClick={handleBackToHome}
                    className="mt-3 h-11 w-full max-w-sm rounded-2xl text-base font-bold"
                    data-testid="not-member-back-home"
                >
                    {t("backToHome")}
                </Button>
            </div>
        </div>
    );
}
