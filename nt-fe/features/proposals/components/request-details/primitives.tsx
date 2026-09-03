"use client";

import {
    ArrowDown01Icon,
    ArrowUp01Icon,
    HelpCircleIcon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Address } from "@/components/address";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { ProfileAvatarChip } from "@/components/profile-avatar-chip";
import { Tooltip } from "@/components/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveUserName, TooltipUser } from "@/components/user";
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
                            icon={HelpCircleIcon}
                            className="size-4 text-card [&_circle]:fill-general-muted-foreground [&_circle]:stroke-general-muted-foreground hover:[&_circle]:fill-general-secondary-foreground hover:[&_circle]:stroke-general-secondary-foreground"
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
 * The raw payload behind a request, kept out of the way until asked for. The
 * toggle sits where a row's value would, so it lines up with the rows above it.
 */
export function TransactionDetails({ payload }: { payload: unknown }) {
    const t = useTranslations("proposals.expanded");
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="flex w-full flex-col gap-1">
            <div className="flex w-full items-center justify-between gap-4 py-1">
                <span className="text-sm font-medium text-general-secondary-foreground">
                    {t("transactionDetails")}
                </span>
                <Button
                    variant="ghost"
                    onClick={() => setIsOpen((open) => !open)}
                    className="h-7 gap-1.5 rounded-sm px-2 text-xs text-general-unofficial-ghost-foreground"
                >
                    {isOpen ? t("hideDetails") : t("showDetails")}
                    <Icon
                        icon={isOpen ? ArrowUp01Icon : ArrowDown01Icon}
                        className="size-[13.25px]"
                    />
                </Button>
            </div>
            {isOpen && (
                <pre className="w-full whitespace-pre-wrap break-words rounded-sm bg-general-bg-tertiary px-3 py-3 font-sans text-sm font-medium text-foreground">
                    {JSON.stringify(payload, null, 2)}
                </pre>
            )}
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
            preferAddressBook
            triggerProps={{ asChild: false }}
        >
            <div className={cn("flex items-center gap-1.5", className)}>
                <ProfileAvatarChip
                    name={name}
                    imageUrl={resolveProfileImageUrl(profile?.image)}
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
