"use client";
import { Icon } from "@/components/icon";
import {
    ArrowUpRight01Icon,
    Delete01Icon,
    ViewIcon,
    ViewOffIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { GuestBadge } from "@/components/guest-badge";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveTreasuryHomeHref } from "@/lib/treasury-home";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { TreasuryBalance, TreasuryLogo } from "@/components/treasury-info";
import {
    useHideTreasuryMutation,
    useRemoveSavedTreasuryMutation,
    useUnhideTreasuryMutation,
} from "@/hooks/use-treasury-mutations";
import { useUserTreasuriesWithOptions } from "@/hooks/use-treasury-queries";
import { useNear } from "@/stores/near-store";
import type { Treasury } from "@/lib/api";
import { StepperHeader } from "@/components/step-wizard";
import { useTreasury } from "@/hooks/use-treasury";

function TreasuryRowSkeleton() {
    return (
        <div className="flex gap-2 items-center bg-tertiary rounded-md px-2 py-1.5">
            <Skeleton className="size-7 rounded-md shrink-0" />
            <div className="flex flex-col flex-1 gap-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="size-6 rounded" />
        </div>
    );
}

function TreasuryRow({
    treasury,
    variant,
    onHide,
    onUnhide,
    onRemove,
    isHidePending,
    isUnhidePending,
    isRemovePending,
    disableAvailabilityActions,
}: {
    treasury: Treasury;
    variant: "active" | "hidden";
    onHide?: () => void;
    onUnhide?: () => void;
    onRemove?: () => void;
    isHidePending?: boolean;
    isUnhidePending?: boolean;
    isRemovePending?: boolean;
    disableAvailabilityActions?: boolean;
}) {
    const tM = useTranslations("manageTreasuries");
    const isGuest = treasury.isSaved && !treasury.isMember;
    const availabilityHint = tM("warningOne");

    return (
        <div className="flex gap-2 items-center bg-general-tertiary rounded-md px-2 py-1.5">
            <TreasuryLogo logo={treasury.config?.metadata?.flagLogo} />
            <div className="flex flex-col flex-1 min-w-0">
                <span className="text-sm font-medium truncate">
                    {treasury.config?.name ?? treasury.daoId}
                </span>
                <TreasuryBalance daoId={treasury.daoId} />
            </div>
            {isGuest && <GuestBadge />}
            {isGuest && onRemove && (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="p-px!"
                    tooltipContent={
                        disableAvailabilityActions
                            ? availabilityHint
                            : tM("tooltips.removeFromList")
                    }
                    onClick={onRemove}
                    disabled={isRemovePending || disableAvailabilityActions}
                >
                    <Icon icon={Delete01Icon} />
                </Button>
            )}
            <Button
                variant="ghost"
                size="icon-sm"
                className="p-px!"
                tooltipContent={tM("tooltips.viewTreasury")}
                asChild
            >
                <Link href={`/${treasury.daoId}`}>
                    <Icon icon={ArrowUpRight01Icon} />
                </Link>
            </Button>
            {variant === "active" && onHide && (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="p-px!"
                    tooltipContent={
                        disableAvailabilityActions
                            ? availabilityHint
                            : tM("tooltips.hideFromList")
                    }
                    onClick={onHide}
                    disabled={isHidePending || disableAvailabilityActions}
                >
                    <Icon icon={ViewIcon} />
                </Button>
            )}
            {variant === "hidden" && onUnhide && (
                <Button
                    variant="ghost"
                    className="p-px!"
                    tooltipContent={tM("tooltips.showInList")}
                    size="icon-sm"
                    onClick={onUnhide}
                    disabled={isUnhidePending}
                >
                    <Icon icon={ViewOffIcon} />
                </Button>
            )}
        </div>
    );
}

export default function ManageTreasuriesPage() {
    const t = useTranslations("pages.manageTreasuries");
    const tM = useTranslations("manageTreasuries");
    const tCommon = useTranslations("common");
    const router = useRouter();
    const { accountId, isInitializing } = useNear();
    const { lastTreasuryId, memberTreasuries } = useTreasury();
    const { data: treasuries = [], isLoading } = useUserTreasuriesWithOptions(
        accountId,
        { includeHidden: true },
    );

    const hideTreasuryMutation = useHideTreasuryMutation(
        accountId,
        { pathname: null, treasuries, push: router.push },
        { navigateOnSuccess: false },
    );
    const removeSavedMutation = useRemoveSavedTreasuryMutation(
        accountId,
        { pathname: null, treasuries, push: router.push },
        { navigateOnSuccess: false },
    );
    const unhideTreasuryMutation = useUnhideTreasuryMutation(accountId);
    const [treasuryToRemove, setTreasuryToRemove] = useState<Treasury | null>(
        null,
    );

    useEffect(() => {
        if (!isInitializing && !accountId) {
            router.push("/");
        }
    }, [accountId, isInitializing, router]);

    const activeTreasuries = treasuries.filter(
        (treasury) => !treasury.isHidden,
    );
    const hiddenTreasuries = treasuries.filter((treasury) => treasury.isHidden);
    const mustKeepOneActive = activeTreasuries.length <= 1;

    return (
        <PageComponentLayout
            title={t("title")}
            description={t("description")}
            backButton={resolveTreasuryHomeHref(
                memberTreasuries,
                lastTreasuryId,
            )}
            hideCollapseButton
        >
            <div className="max-w-[720px] mx-auto">
                <PageCard>
                    {/* Active Treasuries */}
                    <div className="flex flex-col gap-1">
                        <StepperHeader title={tM("activeHeading")} />
                        <p className="text-sm text-muted-foreground">
                            {tM("activeDescription")}
                        </p>
                        {mustKeepOneActive && activeTreasuries.length > 0 && (
                            <p className="text-sm text-warning">
                                {tM("warningOnePeriod")}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-col gap-3">
                        {isLoading ? (
                            <>
                                <TreasuryRowSkeleton />
                                <TreasuryRowSkeleton />
                                <TreasuryRowSkeleton />
                            </>
                        ) : activeTreasuries.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {tM("activeEmpty")}
                            </p>
                        ) : (
                            activeTreasuries.map((treasury) => (
                                <TreasuryRow
                                    key={treasury.daoId}
                                    treasury={treasury}
                                    variant="active"
                                    onHide={() =>
                                        hideTreasuryMutation.mutate(
                                            treasury.daoId,
                                        )
                                    }
                                    onRemove={
                                        treasury.isSaved && !treasury.isMember
                                            ? () =>
                                                  setTreasuryToRemove(treasury)
                                            : undefined
                                    }
                                    isHidePending={
                                        hideTreasuryMutation.isPending
                                    }
                                    isRemovePending={
                                        removeSavedMutation.isPending
                                    }
                                    disableAvailabilityActions={
                                        mustKeepOneActive
                                    }
                                />
                            ))
                        )}
                    </div>

                    {/* Hidden Treasuries - only show when there are hidden items */}
                    {hiddenTreasuries.length > 0 && (
                        <>
                            <div className="flex flex-col gap-1">
                                <StepperHeader title={tM("hiddenHeading")} />
                                <p className="text-sm text-muted-foreground">
                                    {tM("hiddenDescription")}
                                </p>
                            </div>
                            <div className="flex flex-col gap-3">
                                {hiddenTreasuries.map((treasury) => (
                                    <TreasuryRow
                                        key={treasury.daoId}
                                        treasury={treasury}
                                        variant="hidden"
                                        onUnhide={() =>
                                            unhideTreasuryMutation.mutate(
                                                treasury.daoId,
                                            )
                                        }
                                        onRemove={
                                            treasury.isSaved &&
                                            !treasury.isMember
                                                ? () =>
                                                      setTreasuryToRemove(
                                                          treasury,
                                                      )
                                                : undefined
                                        }
                                        isUnhidePending={
                                            unhideTreasuryMutation.isPending
                                        }
                                        isRemovePending={
                                            removeSavedMutation.isPending
                                        }
                                    />
                                ))}
                            </div>
                        </>
                    )}
                </PageCard>
            </div>

            <Dialog
                open={!!treasuryToRemove}
                onOpenChange={(open) => !open && setTreasuryToRemove(null)}
            >
                <DialogContent className="max-w-md gap-4">
                    <DialogHeader>
                        <DialogTitle className="text-left">
                            {tM("removeGuestTitle")}
                        </DialogTitle>
                    </DialogHeader>
                    <DialogDescription>
                        {tM.rich("removeDialog", {
                            name:
                                treasuryToRemove?.config?.name ??
                                treasuryToRemove?.daoId ??
                                "",
                            bold: (chunks) => (
                                <span className="font-semibold">{chunks}</span>
                            ),
                        })}
                    </DialogDescription>
                    <DialogFooter>
                        <Button
                            variant="destructive"
                            className="w-full"
                            disabled={
                                removeSavedMutation.isPending ||
                                (mustKeepOneActive &&
                                    !!treasuryToRemove &&
                                    !treasuryToRemove.isHidden)
                            }
                            onClick={() => {
                                if (!treasuryToRemove) return;
                                if (
                                    mustKeepOneActive &&
                                    !treasuryToRemove.isHidden
                                ) {
                                    return;
                                }
                                removeSavedMutation.mutate(
                                    treasuryToRemove.daoId,
                                    {
                                        onSuccess: () =>
                                            setTreasuryToRemove(null),
                                    },
                                );
                            }}
                        >
                            {removeSavedMutation.isPending
                                ? tCommon("removing")
                                : tCommon("remove")}
                        </Button>
                        {mustKeepOneActive &&
                            !!treasuryToRemove &&
                            !treasuryToRemove.isHidden && (
                                <p className="text-sm text-warning">
                                    {tM("warningOnePeriod")}
                                </p>
                            )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageComponentLayout>
    );
}
