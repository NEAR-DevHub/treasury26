import { useEffect, useState } from "react";
import { ContactRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProfile } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Button } from "./button";
import { Tooltip, TooltipProps } from "./tooltip";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import { CopyButton } from "./copy-button";
import { Address } from "./address";
import { HighlightedText } from "./highlighted-text";
import { getExplorerAddressUrl } from "@/lib/blockchain-utils";
import { stripNearComAddressPrefix } from "@/lib/nearcom-address";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

// ─── Shared types ─────────────────────────────────────────────────────────────

export const sizeClasses = {
    sm: "size-6",
    md: "size-8",
    lg: "size-10",
} as const;

type UserSize = keyof typeof sizeClasses;

/** How to render the user row. */
export type UserVariant =
    /** Avatar + name + address (default) */
    | "full"
    /** Avatar only */
    | "avatar"
    /** Name + address only */
    | "details";

const avatarTextSizeClasses = {
    sm: "text-[10px]",
    md: "text-xs",
    lg: "text-sm",
} as const;

/** Trim and drop empty / whitespace-only display names. */
export function normalizeDisplayName(
    name: string | null | undefined,
): string | undefined {
    const trimmed = name?.trim();
    return trimmed ? trimmed : undefined;
}

/**
 * Resolve the label to show for an account.
 * Default: override → profile/DB (includes treasury branding) → account id.
 * With `preferAddressBook`: override → address-book → profile/DB → account id.
 */
export function resolveUserDisplayName({
    accountId,
    name,
    profileName,
    addressBookName,
    preferAddressBook = false,
}: {
    accountId: string;
    name?: string | null;
    profileName?: string | null;
    addressBookName?: string | null;
    /** When true (request details only), prefer address-book name over profile. */
    preferAddressBook?: boolean;
}): string {
    return (
        normalizeDisplayName(name) ??
        (preferAddressBook
            ? normalizeDisplayName(addressBookName)
            : undefined) ??
        normalizeDisplayName(profileName) ??
        accountId
    );
}

function isSameAccountLabel(name: string, address: string): boolean {
    return name.trim().toLowerCase() === address.trim().toLowerCase();
}

function getUserAvatarInitial(name: string, address: string): string {
    if (name && !isSameAccountLabel(name, address)) {
        return name.charAt(0).toUpperCase();
    }
    return address.charAt(0).toLowerCase();
}

function UserAvatarFallback({
    name,
    address,
    size = "sm",
}: {
    name: string;
    address: string;
    size?: UserSize;
}) {
    return (
        <div
            className={cn(
                "rounded-full shrink-0 flex items-center justify-center bg-accent text-accent-foreground font-medium",
                sizeClasses[size],
                avatarTextSizeClasses[size],
            )}
            aria-hidden
        >
            {getUserAvatarInitial(name, address)}
        </div>
    );
}

function UserAvatar({
    name,
    address,
    imageUrl,
    size = "sm",
}: {
    name: string;
    address: string;
    imageUrl?: string;
    size?: UserSize;
}) {
    const [hasImageError, setHasImageError] = useState(false);

    useEffect(() => {
        setHasImageError(false);
    }, [imageUrl]);

    if (!imageUrl || hasImageError) {
        return <UserAvatarFallback name={name} address={address} size={size} />;
    }

    return (
        <div className="rounded-full flex bg-muted border border-border">
            <img
                src={imageUrl}
                alt={name}
                className={cn(
                    "rounded-full shrink-0 object-cover",
                    sizeClasses[size],
                )}
                onError={() => setHasImageError(true)}
            />
        </div>
    );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

const skeletonSizeClasses = {
    sm: { avatar: "size-6", name: "h-3.5 w-20", address: "h-3 w-24" },
    md: { avatar: "size-8", name: "h-4 w-24", address: "h-3 w-28" },
    lg: { avatar: "size-10", name: "h-4 w-28", address: "h-3.5 w-32" },
};

export function UserSkeleton({
    variant = "full",
    size = "sm",
}: {
    variant?: UserVariant;
    size?: UserSize;
}) {
    const s = skeletonSizeClasses[size];
    const showAvatar = variant !== "details";
    const showDetails = variant !== "avatar";

    return (
        <div className="flex items-center gap-1.5">
            {showAvatar && (
                <Skeleton className={cn("rounded-full shrink-0", s.avatar)} />
            )}
            {showDetails && (
                <div className="flex flex-col items-start gap-1 min-w-0">
                    <Skeleton className={s.name} />
                    <Skeleton className={s.address} />
                </div>
            )}
        </div>
    );
}

// ─── UserWithData — pure render, no fetching ──────────────────────────────────

interface UserWithDataProps {
    name: string;
    address: string;
    /**
     * Visual override (e.g. `nearcom:alice.near`). Explorer / profile keep
     * using the bare `address`.
     */
    displayAddress?: string;
    imageUrl?: string;
    variant?: UserVariant;
    size?: UserSize;
    withLink?: boolean;
    withHoverCard?: boolean;
    chainName?: string;
    /** When set, matching substrings in name/address are highlighted. */
    highlightQuery?: string;
    /** When false, show the full address (no middle ellipsis). Default true. */
    truncateAddress?: boolean;
}

export function UserWithData({
    name,
    address,
    displayAddress,
    imageUrl,
    size = "sm",
    variant = "full",
    withLink = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
    highlightQuery,
    truncateAddress = true,
}: UserWithDataProps) {
    const bareAddress = stripNearComAddressPrefix(address);
    const visibleAddress = displayAddress ?? address;
    const explorerUrl = getExplorerAddressUrl(chainName, bareAddress);
    const showAvatar = variant !== "details";
    const showDetails = variant !== "avatar";

    // When there is no distinct display name, show the address once (never twice).
    // Treat bare account and nearcom:-prefixed display as the same label so the
    // prefixed form is shown instead of hiding behind the bare id.
    const nameIsAddress =
        isSameAccountLabel(name, address) ||
        isSameAccountLabel(name, visibleAddress) ||
        isSameAccountLabel(name, bareAddress);
    const primaryText = nameIsAddress ? visibleAddress : name;

    const addressNode = truncateAddress ? (
        highlightQuery ? (
            <HighlightedText
                text={nameIsAddress ? primaryText : visibleAddress}
                query={highlightQuery}
                className={cn(
                    "max-w-full",
                    nameIsAddress
                        ? "font-medium text-sm truncate"
                        : "text-xs text-muted-foreground truncate",
                )}
            />
        ) : (
            <Address
                address={nameIsAddress ? primaryText : visibleAddress}
                className={cn(
                    "max-w-full",
                    nameIsAddress
                        ? "font-medium text-sm"
                        : "text-xs text-muted-foreground",
                )}
            />
        )
    ) : (
        <span
            className={cn(
                "max-w-full break-all",
                nameIsAddress
                    ? "font-medium text-sm"
                    : "text-xs text-muted-foreground",
            )}
        >
            {nameIsAddress ? primaryText : visibleAddress}
        </span>
    );

    const content = (
        <>
            {showAvatar && (
                <UserAvatar
                    name={name}
                    address={visibleAddress}
                    imageUrl={imageUrl}
                    size={size}
                />
            )}
            {showDetails && (
                <div
                    className={cn(
                        "flex flex-col items-start min-w-0",
                        truncateAddress
                            ? "max-w-[min(100%,15rem)] md:max-w-[min(100%,20rem)]"
                            : "max-w-full",
                    )}
                >
                    {nameIsAddress ? (
                        addressNode
                    ) : (
                        <>
                            <HighlightedText
                                text={name}
                                query={highlightQuery}
                                className="font-medium truncate max-w-full text-sm"
                            />
                            {addressNode}
                        </>
                    )}
                </div>
            )}
        </>
    );

    const userElement =
        withLink && explorerUrl ? (
            <Link
                href={explorerUrl}
                target="_blank"
                className="flex items-center gap-1.5 min-w-0"
            >
                {content}
            </Link>
        ) : (
            <div className="flex items-center gap-1.5 min-w-0">{content}</div>
        );

    if (withHoverCard) {
        return (
            <TooltipUser
                accountId={bareAddress}
                name={name}
                displayAddress={displayAddress}
                chainName={chainName}
                triggerProps={{ asChild: false }}
            >
                {userElement}
            </TooltipUser>
        );
    }

    return userElement;
}

// ─── TooltipUser ──────────────────────────────────────────────────────────────

interface TooltipUserProps {
    accountId: string;
    name?: string;
    /** Copied / shown in the card when set (e.g. nearcom: prefix). */
    displayAddress?: string;
    chainName?: string;
    /** Prefer address-book name in the tooltip User (request details). */
    preferAddressBook?: boolean;
    children: React.ReactNode;
    triggerProps?: TooltipProps["triggerProps"];
}

export function TooltipUser({
    accountId,
    name,
    displayAddress,
    chainName = NEAR_NETWORK_ID,
    preferAddressBook = false,
    children,
    triggerProps,
}: TooltipUserProps) {
    const t = useTranslations("user");
    const { treasuryId, isGuestTreasury, config } = useTreasury();
    const bareAccountId = stripNearComAddressPrefix(accountId);
    const { data: profile, isLoading: isProfileLoading } =
        useProfile(bareAccountId);
    const treasuryName =
        bareAccountId && treasuryId && bareAccountId === treasuryId
            ? config?.name
            : undefined;
    const isSavedInAddressBook = profile?.isInAddressBook ?? false;
    const addressBookParams = new URLSearchParams({
        name: resolveUserDisplayName({
            accountId: bareAccountId,
            name,
            profileName: profile?.name ?? treasuryName,
            addressBookName: profile?.addressBookName,
            preferAddressBook,
        }),
        address: bareAccountId,
    });
    addressBookParams.set("network", chainName);
    const copyText = displayAddress ?? bareAccountId;

    const addToAddressBookUrl = treasuryId
        ? `/${treasuryId}/address-book?${addressBookParams.toString()}`
        : null;

    return (
        <Tooltip
            content={
                <div className="flex flex-col gap-2">
                    <User
                        accountId={bareAccountId}
                        name={name}
                        displayAddress={displayAddress}
                        preferAddressBook={preferAddressBook}
                        size="lg"
                        withLink={false}
                    />
                    <Separator className="h-0.5!" />
                    <div className="flex flex-col gap-1">
                        {!isProfileLoading &&
                            !isSavedInAddressBook &&
                            addToAddressBookUrl &&
                            !isGuestTreasury && (
                                <Button asChild type="button" variant="ghost">
                                    <Link href={addToAddressBookUrl}>
                                        <ContactRound className="size-4" />
                                        {t("saveToAddressBook")}
                                    </Link>
                                </Button>
                            )}
                        <CopyButton
                            text={copyText}
                            toastMessage={t("walletCopiedToast")}
                            variant="ghost"
                        >
                            <span className="break-all">
                                {t("copyWalletAddress")}
                            </span>
                        </CopyButton>
                    </div>
                </div>
            }
            contentProps={{ className: "max-w-72 min-w-60" }}
            triggerProps={triggerProps}
        >
            {children}
        </Tooltip>
    );
}

// ─── User — fetches profile then delegates to UserWithData ────────────────────

interface UserProps {
    accountId: string;
    /** Override the display name instead of fetching from profile */
    name?: string;
    /**
     * Visual address override (e.g. `nearcom:…`). Does not affect profile
     * lookup or explorer links.
     */
    displayAddress?: string;
    variant?: UserVariant;
    size?: UserSize;
    withLink?: boolean;
    withHoverCard?: boolean;
    chainName?: string;
    /**
     * Prefer treasury address-book name over profile/Social.
     * Use only in request (proposal) details.
     */
    preferAddressBook?: boolean;
    /** When set, matching substrings in name/address are highlighted. */
    highlightQuery?: string;
    /** When false, show the full address (no middle ellipsis). Default true. */
    truncateAddress?: boolean;
}

export function User({
    accountId,
    name: nameProp,
    displayAddress,
    variant = "full",
    size = "sm",
    withLink = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
    preferAddressBook = false,
    highlightQuery,
    truncateAddress = true,
}: UserProps) {
    const bareAccountId = stripNearComAddressPrefix(accountId);
    const { data: profile, isLoading } = useProfile(bareAccountId);
    const { treasuryId, config } = useTreasury();
    const treasuryName =
        bareAccountId && treasuryId && bareAccountId === treasuryId
            ? config?.name
            : undefined;

    if (
        isLoading &&
        !normalizeDisplayName(nameProp) &&
        !normalizeDisplayName(treasuryName)
    ) {
        return <UserSkeleton variant={variant} size={size} />;
    }

    const resolvedName = resolveUserDisplayName({
        accountId: bareAccountId,
        name: nameProp,
        profileName: profile?.name ?? treasuryName,
        addressBookName: profile?.addressBookName,
        preferAddressBook,
    });

    return (
        <UserWithData
            name={resolvedName}
            address={bareAccountId}
            displayAddress={displayAddress}
            imageUrl={resolveProfileImageUrl(profile?.image)}
            size={size}
            variant={variant}
            withLink={withLink}
            withHoverCard={withHoverCard}
            chainName={chainName}
            highlightQuery={highlightQuery}
            truncateAddress={truncateAddress}
        />
    );
}
