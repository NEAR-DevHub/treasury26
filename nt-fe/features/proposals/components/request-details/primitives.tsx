"use client";

import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Address } from "@/components/address";
import { Icon } from "@/components/icon";
import { Tooltip } from "@/components/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveUserName, TooltipUser, UserAvatar } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useProfile } from "@/hooks/use-treasury-queries";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import { cn } from "@/lib/utils";

/**
 * One of the bordered blocks the request details are broken into. The design
 * gives the amount block a wider radius than the blocks of rows below it.
 */
export function DetailsCard({
    className,
    children,
}: {
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "rounded-2xl border border-general-border",
                className,
            )}
        >
            {children}
        </div>
    );
}

/**
 * Label on the left, value pushed to the right. `align` is for values that run
 * to several lines (a note), where the label should sit on the first one.
 */
export function DetailRow({
    label,
    info,
    value,
    align = "center",
}: {
    label: string;
    info?: string;
    value: ReactNode;
    align?: "center" | "start";
}) {
    return (
        <div
            className={cn(
                "flex w-full justify-between gap-4 py-2",
                align === "start" ? "items-start" : "items-center",
            )}
        >
            <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-medium text-general-secondary-foreground">
                    {label}
                </span>
                {info && (
                    <Tooltip content={info}>
                        <Icon
                            icon={InformationCircleIcon}
                            className="size-4 text-general-muted-foreground"
                        />
                    </Tooltip>
                )}
            </div>
            <div className="min-w-0 text-right text-sm font-semibold text-foreground">
                {value}
            </div>
        </div>
    );
}

/**
 * An account as the renovated request views show it: a 28px rounded-square
 * avatar, the display name, and the wallet underneath. Distinct from `User`,
 * which draws a circular avatar and a smaller second line.
 */
export function RequestParty({
    accountId,
    chainName = NEAR_NETWORK_ID,
    className,
}: {
    accountId: string;
    chainName?: string;
    className?: string;
}) {
    const { data: profile, isLoading } = useProfile(accountId);

    if (isLoading) {
        return (
            <div className="flex items-center gap-1.5">
                <Skeleton className="size-7 shrink-0 rounded-lg" />
                <div className="flex flex-col gap-1">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-24" />
                </div>
            </div>
        );
    }

    const name = resolveUserName({
        accountId,
        profile,
        useAddressBook: true,
    });
    const nameIsAddress = name === accountId;

    return (
        <TooltipUser
            accountId={accountId}
            chainName={chainName}
            useAddressBook
            triggerProps={{ asChild: false }}
        >
            <div className={cn("flex items-center gap-1.5", className)}>
                <UserAvatar
                    name={name}
                    address={accountId}
                    imageUrl={resolveProfileImageUrl(profile?.image)}
                    className="size-7 rounded-lg"
                />
                <div className="flex min-w-0 flex-col text-left">
                    {!nameIsAddress && (
                        <span className="truncate text-sm font-semibold leading-[1.5]">
                            {name}
                        </span>
                    )}
                    <Address
                        address={accountId}
                        prefixLength={6}
                        suffixLength={6}
                        className={cn(
                            "text-sm leading-[1.5]",
                            nameIsAddress
                                ? "font-semibold"
                                : "font-medium text-general-secondary-foreground",
                        )}
                    />
                </div>
            </div>
        </TooltipUser>
    );
}
