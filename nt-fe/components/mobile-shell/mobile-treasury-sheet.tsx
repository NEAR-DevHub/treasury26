"use client";

import { Add01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Icon } from "@/components/icon";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import { TreasuryBalance, TreasuryLogo } from "@/components/treasury-info";
import { useOpenTreasury } from "@/hooks/use-open-treasury";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useMobileShellStore } from "@/stores/mobile-shell-store";

export function MobileTreasurySheet() {
    const t = useTranslations("treasurySelector");
    const router = useRouter();
    const pathname = usePathname();
    const { open } = useOpenTreasury();
    const { treasuryId, treasuries } = useTreasury();
    const sheet = useMobileShellStore((state) => state.sheet);
    const closeSheet = useMobileShellStore((state) => state.closeSheet);

    const memberTreasuries = useMemo(
        () => treasuries.filter((treasury) => treasury.isMember),
        [treasuries],
    );
    const savedGuestTreasuries = useMemo(
        () =>
            treasuries.filter(
                (treasury) => treasury.isSaved && !treasury.isMember,
            ),
        [treasuries],
    );

    const handleSelect = (newTreasuryId: string) => {
        closeSheet();
        open(newTreasuryId);
        const pathAfterTreasury = pathname?.split("/").slice(2).join("/") || "";
        if (
            pathAfterTreasury === "pay/public" ||
            pathAfterTreasury === "pay/confidential" ||
            pathAfterTreasury.startsWith("pay/public/") ||
            pathAfterTreasury.startsWith("pay/confidential/")
        ) {
            router.push(`/${newTreasuryId}/dashboard/deposit`);
            return;
        }
        router.push(`/${newTreasuryId}/${pathAfterTreasury}`);
    };

    const createTreasuryRoute = `/create?returnTo=${encodeURIComponent(pathname || "/")}`;

    const renderRow = (
        daoId: string,
        name: string | null | undefined,
        logo: string | null | undefined,
        confidential: boolean | undefined,
        hideBalance?: boolean,
    ) => (
        <button
            key={daoId}
            type="button"
            onClick={() => handleSelect(daoId)}
            className={cn(
                "flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left -mx-2",
                daoId === treasuryId && "bg-muted/70",
            )}
        >
            <TreasuryLogo
                logo={logo}
                isConfidential={confidential ?? false}
                imageClassName="size-10 rounded-full"
                fallbackClassName="size-10 rounded-full bg-green-700"
                fallbackIconClassName="size-5 text-white"
            />
            <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">
                    {name ?? daoId}
                </p>
                <TreasuryBalance
                    daoId={daoId}
                    className="truncate text-sm text-muted-foreground"
                    skeletonClassName="h-3 w-20"
                    isConfidential={hideBalance}
                />
            </div>
        </button>
    );

    return (
        <Dialog
            open={sheet === "treasury"}
            onOpenChange={(open) => {
                if (!open) closeSheet();
            }}
        >
            <DialogContent className="overflow-hidden">
                <SheetHandle />
                <DialogTitle className="sr-only">{t("select")}</DialogTitle>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {memberTreasuries.map((treasury) =>
                        renderRow(
                            treasury.daoId,
                            treasury.config?.name,
                            treasury.config.metadata?.flagLogo,
                            treasury.isConfidential,
                        ),
                    )}
                    {savedGuestTreasuries.map((treasury) =>
                        renderRow(
                            treasury.daoId,
                            treasury.config?.name,
                            treasury.config.metadata?.flagLogo,
                            treasury.isConfidential,
                            treasury.isConfidential,
                        ),
                    )}
                </div>
                <div className="shrink-0 border-t border-border pt-2">
                    <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl py-2.5 text-left font-semibold text-foreground"
                        onClick={() => {
                            closeSheet();
                            router.push("/app/manage-treasuries");
                        }}
                    >
                        <Icon icon={Settings01Icon} className="size-5" />
                        {t("manageTreasuries")}
                    </button>
                    <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl py-2.5 text-left font-semibold text-foreground"
                        onClick={() => {
                            closeSheet();
                            router.push(createTreasuryRoute);
                        }}
                    >
                        <Icon icon={Add01Icon} className="size-5" />
                        {t("createTreasury")}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
