"use client";
import {
    ArrowUpRight01Icon,
    Delete01Icon,
    ViewIcon,
    ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { GuestBadge } from "@/components/guest-badge";
import { Icon } from "@/components/icon";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { PageComponentLayout } from "@/components/page-component-layout";
import { TreasuryBalance, TreasuryLogo } from "@/components/treasury-info";
import { Skeleton } from "@/components/ui/skeleton";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useHideTreasuryMutation,
    useRemoveSavedTreasuryMutation,
    useUnhideTreasuryMutation,
} from "@/hooks/use-treasury-mutations";
import { useUserTreasuriesWithOptions } from "@/hooks/use-treasury-queries";
import type { Treasury } from "@/lib/api";
import { resolveTreasuryHomeHref } from "@/lib/treasury-home";
import { useNear } from "@/stores/near-store";

/**
 * The design gives each list its own narrow card, centred rather than spread
 * across the page, and lines the cards up with the back button on a phone.
 * The stacked mobile header already leaves a gap above the first card, so the
 * 20px the design puts under the header only kicks in from `lg`.
 */
const COLUMN_CLASS = "mx-auto flex w-full max-w-[464px] flex-col gap-5 lg:pt-5";
const MAIN_CLASS = "px-3 md:px-6";
/**
 * The 28px, 8px-radius square the design gives each row's controls. The theme
 * scales `rounded-lg` to 12px, so 8px is `rounded-sm`.
 */
const ROW_ICON_BUTTON_CLASS =
    "size-7 rounded-sm text-general-secondary-foreground";

function TreasurySection({
    title,
    description,
    children,
}: {
    title: string;
    description: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <PageCard className="gap-3 rounded-3xl p-5">
            <div className="flex flex-col gap-[5px]">
                <h2 className="font-semibold text-base leading-[1.2]">
                    {title}
                </h2>
                <div className="text-sm text-general-secondary-foreground">
                    {description}
                </div>
            </div>
            <div className="flex flex-col">{children}</div>
        </PageCard>
    );
}

function TreasuryRowSkeleton() {
    return (
        <div className="flex items-center gap-2 py-2">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="size-7 rounded-sm" />
            <Skeleton className="size-7 rounded-sm" />
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
        <div className="flex items-center gap-2 py-2">
            <TreasuryLogo
                logo={treasury.config?.metadata?.flagLogo}
                imageClassName="size-9 rounded-full"
                fallbackClassName="size-9 rounded-full bg-green-700"
                fallbackIconClassName="size-4 text-white"
            />
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-sm leading-[1.5]">
                    {treasury.config?.name ?? treasury.daoId}
                </span>
                <TreasuryBalance daoId={treasury.daoId} className="text-xs" />
            </div>
            {isGuest && <GuestBadge />}
            {isGuest && onRemove && (
                <Button
                    variant="neutral"
                    size="icon-sm"
                    className={ROW_ICON_BUTTON_CLASS}
                    tooltipContent={
                        disableAvailabilityActions
                            ? availabilityHint
                            : tM("tooltips.removeFromList")
                    }
                    onClick={onRemove}
                    disabled={isRemovePending || disableAvailabilityActions}
                >
                    <Icon icon={Delete01Icon} className="size-3.5" />
                </Button>
            )}
            <Button
                variant="neutral"
                size="icon-sm"
                className={ROW_ICON_BUTTON_CLASS}
                tooltipContent={tM("tooltips.viewTreasury")}
                asChild
            >
                <Link href={`/${treasury.daoId}`}>
                    <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
                </Link>
            </Button>
            {variant === "active" && onHide && (
                <Button
                    variant="neutral"
                    size="icon-sm"
                    className={ROW_ICON_BUTTON_CLASS}
                    tooltipContent={
                        disableAvailabilityActions
                            ? availabilityHint
                            : tM("tooltips.hideFromList")
                    }
                    onClick={onHide}
                    disabled={isHidePending || disableAvailabilityActions}
                >
                    <Icon icon={ViewOffSlashIcon} className="size-3.5" />
                </Button>
            )}
            {variant === "hidden" && onUnhide && (
                <Button
                    variant="neutral"
                    size="icon-sm"
                    className={ROW_ICON_BUTTON_CLASS}
                    tooltipContent={tM("tooltips.showInList")}
                    onClick={onUnhide}
                    disabled={isUnhidePending}
                >
                    <Icon icon={ViewIcon} className="size-3.5" />
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
            backButton={resolveTreasuryHomeHref(
                memberTreasuries,
                lastTreasuryId,
            )}
            hideCollapseButton
            hideHeaderControls
            transparentHeader
            hideHeaderBottomBorder
            hideMobileShellControls
            hideTitle
            mainClassName={MAIN_CLASS}
        >
            <div className={COLUMN_CLASS}>
                <TreasurySection
                    title={tM("activeHeading")}
                    description={
                        <>
                            {tM("activeDescription")}
                            {mustKeepOneActive &&
                                activeTreasuries.length > 0 && (
                                    <span className="block text-warning">
                                        {tM("warningOnePeriod")}
                                    </span>
                                )}
                        </>
                    }
                >
                    {isLoading ? (
                        <>
                            <TreasuryRowSkeleton />
                            <TreasuryRowSkeleton />
                            <TreasuryRowSkeleton />
                        </>
                    ) : activeTreasuries.length === 0 ? (
                        <p className="py-2 text-sm text-general-secondary-foreground">
                            {tM("activeEmpty")}
                        </p>
                    ) : (
                        activeTreasuries.map((treasury) => (
                            <TreasuryRow
                                key={treasury.daoId}
                                treasury={treasury}
                                variant="active"
                                onHide={() =>
                                    hideTreasuryMutation.mutate(treasury.daoId)
                                }
                                onRemove={
                                    treasury.isSaved && !treasury.isMember
                                        ? () => setTreasuryToRemove(treasury)
                                        : undefined
                                }
                                isHidePending={hideTreasuryMutation.isPending}
                                isRemovePending={removeSavedMutation.isPending}
                                disableAvailabilityActions={mustKeepOneActive}
                            />
                        ))
                    )}
                </TreasurySection>

                {/* Hidden Treasuries - only show when there are hidden items */}
                {hiddenTreasuries.length > 0 && (
                    <TreasurySection
                        title={tM("hiddenHeading")}
                        description={tM("hiddenDescription")}
                    >
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
                                    treasury.isSaved && !treasury.isMember
                                        ? () => setTreasuryToRemove(treasury)
                                        : undefined
                                }
                                isUnhidePending={
                                    unhideTreasuryMutation.isPending
                                }
                                isRemovePending={removeSavedMutation.isPending}
                            />
                        ))}
                    </TreasurySection>
                )}
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
