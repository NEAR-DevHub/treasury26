"use client";
import { Icon } from "@/components/icon";
import { Alert01Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DepositAddressCard } from "./deposit-address-card";
import type { DepositNoticeTone } from "./deposit-notice-icon";
import {
    DepositNoticeInfoRow,
    DepositNoticeList,
    type DepositNoticeItem,
} from "./deposit-notice-list";

export type AddressNoticeTone = DepositNoticeTone;

export type AddressNotice = DepositNoticeItem;

interface DepositAddressViewProps {
    title: string;
    subtitle?: string;
    address: string;
    memo?: string | null;
    /**
     * Skip middle-highlight formatting (show the address as plain text).
     * Used for the reusable confidential treasury account (sputnik-dao id),
     * where highlighting adds little and can look odd on a `.near` name.
     */
    preferPlainAddress?: boolean;
    notices: AddressNotice[];
    onShare?: () => void;
    onCreateNewAddress?: () => void;
    createNewAddressDisabled?: boolean;
    showShare?: boolean;
    /** In-flow back to the previous deposit step (asset/network select). */
    onBack?: () => void;
    className?: string;
    /** Shown above the title (e.g. public slow-network banner). */
    warningSlot?: ReactNode;
    headerSlot?: ReactNode;
}

export function DepositAddressSkeleton({ className }: { className?: string }) {
    return (
        <div
            className={cn("space-y-4", className)}
            data-testid="deposit-address-skeleton"
        >
            <div className="space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
            </div>

            <div className="rounded-xl overflow-hidden border border-general-border bg-card">
                <div className="bg-card p-3">
                    <div className="flex flex-col items-center gap-3 md:flex-row md:items-center">
                        <Skeleton className="size-22 rounded-lg shrink-0" />
                        <div className="w-full md:flex-1 min-w-0 space-y-2 md:pt-1">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-5 w-full" />
                            <Skeleton className="h-5 w-4/5" />
                        </div>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-2 p-3">
                    <Skeleton className="h-10 rounded-xl" />
                    <Skeleton className="h-10 rounded-xl" />
                </div>
            </div>

            <div className="space-y-2.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-2/3" />
            </div>
        </div>
    );
}

export function DepositAddressView({
    title,
    subtitle,
    address,
    memo,
    preferPlainAddress = false,
    notices,
    onShare,
    onCreateNewAddress,
    createNewAddressDisabled = false,
    showShare = true,
    onBack,
    className,
    warningSlot,
    headerSlot,
}: DepositAddressViewProps) {
    const t = useTranslations("depositModal");

    return (
        <div className={cn("space-y-6", className)}>
            {warningSlot}
            {headerSlot}
            <div>
                {onBack && (
                    <Button
                        type="button"
                        variant="unstyled"
                        onClick={onBack}
                        className="mb-3 inline-flex h-auto items-center gap-1 p-0 text-sm font-semibold text-general-foreground hover:opacity-80"
                        data-testid="deposit-address-back"
                    >
                        <Icon icon={ArrowLeft01Icon} className="size-4" />
                        {t("back")}
                    </Button>
                )}
                <h2 className="text-xl font-semibold leading-7 tracking-tight text-foreground">
                    {title}
                </h2>
                {subtitle && (
                    <p className="mt-1 text-base font-medium leading-tight text-muted-foreground">
                        {subtitle}
                    </p>
                )}
            </div>

            <DepositAddressCard
                address={address}
                memo={memo}
                preferPlainAddress={preferPlainAddress}
                copyMode="actions"
                showShare={showShare}
                onShare={onShare}
            />

            <DepositNoticeList
                notices={notices}
                footer={
                    onCreateNewAddress ? (
                        <DepositNoticeInfoRow>
                            {t.rich("createNewAddressHint", {
                                link: (chunks) => (
                                    <button
                                        type="button"
                                        onClick={onCreateNewAddress}
                                        disabled={createNewAddressDisabled}
                                        className="underline text-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                        data-testid="deposit-create-new-address"
                                    >
                                        {chunks}
                                    </button>
                                ),
                            })}
                        </DepositNoticeInfoRow>
                    ) : undefined
                }
            />

            {memo && (
                <div className="flex gap-2 items-start text-sm bg-destructive/10 text-destructive rounded-lg p-3">
                    <Icon icon={Alert01Icon} className="shrink-0 mt-0.5" />
                    <span>
                        {t.rich("memoWarning", {
                            bold: (chunks) => (
                                <span className="text-foreground">
                                    {chunks}
                                </span>
                            ),
                        })}
                    </span>
                </div>
            )}
        </div>
    );
}
