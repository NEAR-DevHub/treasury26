"use client";

import { Plus, Settings } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useMemo } from "react";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
} from "@/components/ui/select";
import { useOpenTreasury } from "@/hooks/use-open-treasury";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { TreasuryBalance, TreasuryLogo } from "./treasury-info";
import { Skeleton } from "./ui/skeleton";

/** The two footer rows ("Manage" / "Create") share the option rows' geometry. */
const actionRowClass =
    "flex h-auto w-full items-center justify-start gap-3 rounded-xl px-2 py-2.5 font-semibold text-gray-600 text-sm transition-colors hover:bg-black/[0.05] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.07] dark:hover:text-white";

/**
 * One treasury row in the dropdown. The check indicator is hidden — the
 * selected treasury is marked by the row's background instead, per the design.
 */
function TreasuryOption({
    daoId,
    name,
    logo,
    isConfidential,
    hideBalance,
}: {
    daoId: string;
    name?: string | null;
    logo?: string | null;
    isConfidential?: boolean;
    hideBalance?: boolean;
}) {
    return (
        <SelectItem
            value={daoId}
            className="cursor-pointer gap-3 rounded-xl px-2 py-2 text-gray-900 focus:bg-black/[0.05] focus:text-gray-900 data-[state=checked]:bg-black/[0.05] dark:text-white dark:focus:bg-white/[0.07] dark:focus:text-white dark:data-[state=checked]:bg-white/[0.07] [&>span:first-child]:hidden"
        >
            <div className="flex min-w-0 items-center gap-3">
                <TreasuryLogo
                    logo={logo}
                    isConfidential={isConfidential ?? false}
                    imageClassName="size-9 rounded-full"
                    fallbackClassName="size-9 rounded-full bg-green-700"
                    fallbackIconClassName="size-5 text-white"
                />
                <div className="flex min-w-0 flex-col items-start">
                    <span className="max-w-full truncate font-semibold text-sm text-gray-900 dark:text-white">
                        {name ?? daoId}
                    </span>
                    <TreasuryBalance
                        daoId={daoId}
                        className="max-w-full truncate font-medium text-gray-500 dark:text-gray-400 text-xs"
                        skeletonClassName="h-3 w-20"
                        isConfidential={hideBalance}
                    />
                </div>
            </div>
        </SelectItem>
    );
}

interface TreasurySelectorProps {
    reducedMode?: boolean;
    isOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
}

export function TreasurySelector({
    reducedMode = false,
    isOpen,
    onOpenChange,
}: TreasurySelectorProps) {
    const t = useTranslations("treasurySelector");
    const router = useRouter();
    const pathname = usePathname();
    const { accountId } = useNear();
    const { open } = useOpenTreasury();

    const {
        isLoading,
        treasuryId,
        config,
        treasuries,
        isConfidential,
        isGuestTreasury,
    } = useTreasury();
    const lockSelectOutside = useOnboardingStore(
        (state) => state.lockSelectOutside,
    );

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

    // Register treasury once when it changes
    React.useEffect(() => {
        open(treasuryId);
    }, [treasuryId, open]);

    React.useEffect(() => {
        if (treasuries.length > 0 && !treasuryId) {
            router.push(`/${treasuries[0].daoId}`);
        }
    }, [treasuries, treasuryId, router]);

    if (isLoading) {
        return (
            <div
                className={cn(
                    "w-full h-fit flex items-center",
                    reducedMode ? "justify-center p-0" : "min-h-15 p-3",
                )}
            >
                <div
                    className={cn(
                        "flex items-center h-9",
                        reducedMode ? "justify-center" : "gap-3",
                    )}
                >
                    <Skeleton className="size-9 rounded-full" />
                    {!reducedMode && (
                        <div className="flex flex-col gap-1">
                            <Skeleton className="h-3 w-20" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const handleTreasuryChange = (newTreasuryId: string) => {
        const pathAfterTreasury = pathname?.split("/").slice(2).join("/") || "";
        router.push(`/${newTreasuryId}/${pathAfterTreasury}`);
    };

    const displayName = config ? (config.name ?? treasuryId) : t("select");
    const createTreasuryRoute = `/create?returnTo=${encodeURIComponent(pathname || "/")}`;

    return (
        <>
            <Select
                value={treasuryId}
                open={isOpen}
                onValueChange={handleTreasuryChange}
                onOpenChange={(open) => {
                    if (!open && lockSelectOutside) return;
                    onOpenChange?.(open);
                }}
            >
                <SelectTrigger
                    id="dashboard-step5"
                    className={cn(
                        // No hover state here — the trigger stays flat against the card.
                        "w-full h-fit cursor-pointer rounded-2xl border-none! ring-0! shadow-none! bg-transparent! hover:bg-transparent! [&>svg]:size-5 [&>svg]:text-gray-500 dark:[&>svg]:text-gray-400 [&>svg]:opacity-100 [&>svg]:transition-transform [&>svg]:duration-150 [&[data-state=open]>svg]:rotate-180",
                        reducedMode
                            ? "p-0 [&>svg]:hidden"
                            : "min-h-15 gap-2 p-3",
                    )}
                    disabled={!accountId}
                >
                    <Tooltip
                        content={t("connectWalletTooltip")}
                        disabled={!!accountId}
                    >
                        <div
                            className={cn(
                                "flex items-center w-full truncate",
                                reducedMode ? "justify-center" : "gap-3",
                            )}
                        >
                            <TreasuryLogo
                                logo={config?.metadata?.flagLogo}
                                isConfidential={isConfidential ?? false}
                                imageClassName="size-9 rounded-full"
                                fallbackClassName="size-9 rounded-full bg-green-700"
                                fallbackIconClassName="size-5 text-white"
                            />
                            {!reducedMode && (
                                <div className="flex min-w-0 flex-col items-start">
                                    <span className="truncate max-w-full font-semibold text-sm text-gray-900 dark:text-white">
                                        {displayName}
                                    </span>
                                    {treasuryId && (
                                        <TreasuryBalance
                                            daoId={treasuryId}
                                            className="truncate max-w-full font-medium text-gray-500 dark:text-gray-400 text-xs"
                                            skeletonClassName="h-3 w-20"
                                            isConfidential={
                                                isConfidential &&
                                                isGuestTreasury
                                            }
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    </Tooltip>
                </SelectTrigger>
                {/* Portalled out of the rail, so it can't inherit the rail's scope:
                    `dark` is re-declared here to keep the popover in step with the
                    always-dark rail it drops out of. */}
                <SelectContent
                    align="start"
                    sideOffset={8}
                    className="dark w-(--radix-select-trigger-width) min-w-56 rounded-2xl border-white/10 bg-gray-950 p-1.5 text-white shadow-xl"
                >
                    {memberTreasuries.length > 0 && (
                        <SelectGroup>
                            {savedGuestTreasuries.length > 0 && (
                                <SelectLabel className="px-2 text-gray-500">
                                    {t("memberOf")}
                                </SelectLabel>
                            )}
                            {memberTreasuries.map((treasury) => (
                                <TreasuryOption
                                    key={treasury.daoId}
                                    daoId={treasury.daoId}
                                    name={treasury.config?.name}
                                    logo={treasury.config.metadata?.flagLogo}
                                    isConfidential={treasury.isConfidential}
                                />
                            ))}
                        </SelectGroup>
                    )}
                    {savedGuestTreasuries.length > 0 && (
                        <>
                            {memberTreasuries.length > 0 && (
                                <SelectSeparator className="-mx-1.5 my-1.5 bg-gray-300 dark:bg-white/10" />
                            )}
                            <SelectGroup>
                                <SelectLabel className="px-2 text-gray-500">
                                    {t("guestTreasuries")}
                                </SelectLabel>
                                {savedGuestTreasuries.map((treasury) => (
                                    <TreasuryOption
                                        key={treasury.daoId}
                                        daoId={treasury.daoId}
                                        name={treasury.config?.name}
                                        logo={
                                            treasury.config.metadata?.flagLogo
                                        }
                                        isConfidential={treasury.isConfidential}
                                        hideBalance={treasury.isConfidential}
                                    />
                                ))}
                            </SelectGroup>
                        </>
                    )}
                    <SelectSeparator className="-mx-1.5 my-1.5 bg-gray-300 dark:bg-white/10" />
                    <Button
                        variant="unstyled"
                        type="button"
                        className={actionRowClass}
                        onClick={() => router.push("/app/manage-treasuries")}
                    >
                        <Settings className="size-5 shrink-0" />
                        <span className="truncate">
                            {t("manageTreasuries")}
                        </span>
                    </Button>
                    <Button
                        id="dashboard-step5-create-treasury"
                        variant="unstyled"
                        type="button"
                        className={actionRowClass}
                        onClick={() => router.push(createTreasuryRoute)}
                    >
                        <Plus className="size-5 shrink-0" />
                        <span className="truncate">{t("createTreasury")}</span>
                    </Button>
                </SelectContent>
            </Select>
        </>
    );
}
