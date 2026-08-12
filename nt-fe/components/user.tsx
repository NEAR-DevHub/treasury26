import { Contact01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useTreasury } from "@/hooks/use-treasury";
import { useProfile } from "@/hooks/use-treasury-queries";
import { getExplorerAddressUrl } from "@/lib/blockchain-utils";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import { cn } from "@/lib/utils";
import { Address } from "./address";
import { Button } from "./button";
import { CopyButton } from "./copy-button";
import { HighlightedText } from "./highlighted-text";
import { Tooltip, type TooltipProps } from "./tooltip";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";

// ─── Shared types ─────────────────────────────────────────────────────────────

export const sizeClasses = {
    sm: "size-6",
    md: "size-8",
    lg: "size-10",
} as const;

type UserSize = keyof typeof sizeClasses;

type UserProfile = ReturnType<typeof useProfile>["data"];

/** Explicit override first, then address-book / profile, then the raw account id. */
export function resolveUserName({
    accountId,
    name,
    profile,
    useAddressBook,
}: {
    accountId: string;
    name?: string;
    profile: UserProfile;
    useAddressBook: boolean;
}) {
    return resolveUserDisplayName({
        accountId,
        name,
        profileName: profile?.name,
        addressBookName: profile?.addressBookName,
        preferAddressBook: useAddressBook,
    });
}

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

interface UserAvatarProps {
    name: string;
    address: string;
    imageUrl?: string;
    size?: UserSize;
    /** Overrides the avatar geometry (size and roundness) for one call site. */
    className?: string;
}

function UserAvatarFallback({
    name,
    address,
    size = "sm",
    className,
}: Omit<UserAvatarProps, "imageUrl">) {
    return (
        <div
            className={cn(
                "rounded-full shrink-0 flex items-center justify-center bg-accent text-accent-foreground font-medium",
                sizeClasses[size],
                avatarTextSizeClasses[size],
                className,
            )}
            aria-hidden
        >
            {getUserAvatarInitial(name, address)}
        </div>
    );
}

export function UserAvatar({
    name,
    address,
    imageUrl,
    size = "sm",
    className,
}: UserAvatarProps) {
    const [hasImageError, setHasImageError] = useState(false);

    useEffect(() => {
        setHasImageError(false);
    }, [imageUrl]);

    if (!imageUrl || hasImageError) {
        return (
            <UserAvatarFallback
                name={name}
                address={address}
                size={size}
                className={className}
            />
        );
    }

    return (
        <img
            src={imageUrl}
            alt={name}
            className={cn(
                "rounded-full shrink-0 border border-border bg-muted object-cover",
                sizeClasses[size],
                className,
            )}
            onError={() => setHasImageError(true)}
        />
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
    imageUrl?: string;
    variant?: UserVariant;
    size?: UserSize;
    withLink?: boolean;
    withHoverCard?: boolean;
    chainName?: string;
    /** When set, matching substrings in name/address are highlighted. */
    highlightQuery?: string;
}

export function UserWithData({
    name,
    address,
    imageUrl,
    size = "sm",
    variant = "full",
    withLink = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
    highlightQuery,
}: UserWithDataProps) {
    const explorerUrl = getExplorerAddressUrl(chainName, address);
    const showAvatar = variant !== "details";
    const showDetails = variant !== "avatar";

    // When there is no distinct display name, show the address once (never twice).
    const nameIsAddress = isSameAccountLabel(name, address);

    const content = (
        <>
            {showAvatar && (
                <UserAvatar
                    name={name}
                    address={address}
                    imageUrl={imageUrl}
                    size={size}
                />
            )}
            {showDetails && (
                <div className="flex flex-col items-start min-w-0 max-w-[min(100%,15rem)] md:max-w-[min(100%,20rem)]">
                    {nameIsAddress ? (
                        highlightQuery ? (
                            <HighlightedText
                                text={address}
                                query={highlightQuery}
                                className="font-medium max-w-full text-sm truncate"
                            />
                        ) : (
                            <Address
                                address={address}
                                className="font-medium max-w-full text-sm"
                            />
                        )
                    ) : (
                        <>
                            <HighlightedText
                                text={name}
                                query={highlightQuery}
                                className="font-medium truncate max-w-full text-sm"
                            />
                            {highlightQuery ? (
                                <HighlightedText
                                    text={address}
                                    query={highlightQuery}
                                    className="text-xs text-muted-foreground truncate max-w-full"
                                />
                            ) : (
                                <Address
                                    address={address}
                                    className="text-xs text-muted-foreground max-w-full"
                                />
                            )}
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
                accountId={address}
                name={name}
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

/**
 * 40px ghost rows, left aligned, that fill the tooltip's 6px action tray.
 * `rounded-lg` is the design's 12px — this project rebases the radius scale on
 * `--radius: 0.75rem`, so `rounded-xl` would be 16px.
 */
const TOOLTIP_ACTION_CLASS =
    "h-10 justify-start rounded-lg px-4 text-sm text-general-unofficial-ghost-foreground";
const TOOLTIP_ACTION_ICON_CLASS = "size-[13.25px]";

interface TooltipUserProps {
    accountId: string;
    name?: string;
    chainName?: string;
    /** Prefer address-book name in the tooltip User (request details). */
    preferAddressBook?: boolean;
    children: React.ReactNode;
    triggerProps?: TooltipProps["triggerProps"];
}

export function TooltipUser({
    accountId,
    name,
    chainName = NEAR_NETWORK_ID,
    preferAddressBook = false,
    children,
    triggerProps,
}: TooltipUserProps) {
    const t = useTranslations("user");
    const { treasuryId, isGuestTreasury } = useTreasury();
    const { data: profile, isLoading: isProfileLoading } =
        useProfile(accountId);
    const isSavedInAddressBook = profile?.isInAddressBook ?? false;
    const resolvedName = resolveUserDisplayName({
        accountId,
        name,
        profileName: profile?.name,
        addressBookName: profile?.addressBookName,
        preferAddressBook,
    });
    const addressBookParams = new URLSearchParams({
        name: resolveUserDisplayName({
            accountId,
            name,
            profileName: profile?.name,
            addressBookName: profile?.addressBookName,
            preferAddressBook,
        }),
        address: accountId,
    });
    addressBookParams.set("network", chainName);

    const addToAddressBookUrl = treasuryId
        ? `/${treasuryId}/address-book?${addressBookParams.toString()}`
        : null;

    // Without a profile name the heading would repeat the wallet verbatim, so
    // the address moves up into it rather than being printed twice.
    const nameIsAddress = resolvedName === accountId;

    return (
        <Tooltip
            content={
                <div className="flex flex-col">
                    <div className="flex items-center gap-3 p-3">
                        <UserAvatar
                            name={resolvedName}
                            address={accountId}
                            imageUrl={resolveProfileImageUrl(profile?.image)}
                            // The design gives the tooltip a 28px rounded
                            // square, not the circle the inline rows use.
                            className="size-7 rounded-lg"
                        />
                        <div className="flex min-w-0 flex-col">
                            {nameIsAddress ? (
                                <Address
                                    address={accountId}
                                    className="text-sm font-semibold leading-[1.5]"
                                />
                            ) : (
                                <>
                                    <span className="truncate text-sm font-semibold leading-[1.5]">
                                        {resolvedName}
                                    </span>
                                    <Address
                                        address={accountId}
                                        className="text-xs leading-4 tracking-[0.18px] text-general-secondary-foreground"
                                    />
                                </>
                            )}
                        </div>
                    </div>
                    <Separator className="bg-general-unofficial-border-3" />
                    <div className="flex flex-col gap-0.5 p-1.5">
                        {!isProfileLoading &&
                            !isSavedInAddressBook &&
                            addToAddressBookUrl &&
                            !isGuestTreasury && (
                                <Button
                                    asChild
                                    type="button"
                                    variant="ghost"
                                    className={TOOLTIP_ACTION_CLASS}
                                >
                                    <Link href={addToAddressBookUrl}>
                                        <Icon
                                            icon={Contact01Icon}
                                            className={
                                                TOOLTIP_ACTION_ICON_CLASS
                                            }
                                        />
                                        {t("saveToAddressBook")}
                                    </Link>
                                </Button>
                            )}
                        <CopyButton
                            text={accountId}
                            variant="ghost"
                            className={TOOLTIP_ACTION_CLASS}
                            iconClassName={TOOLTIP_ACTION_ICON_CLASS}
                        >
                            {t("copyWalletAddress")}
                        </CopyButton>
                    </div>
                </div>
            }
            contentProps={{
                className:
                    "w-[233px] max-w-none rounded-2xl border-transparent bg-general-bg-secondary p-0",
            }}
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
}

export function User({
    accountId,
    name: nameProp,
    variant = "full",
    size = "sm",
    withLink = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
    preferAddressBook = false,
    highlightQuery,
}: UserProps) {
    const { data: profile, isLoading } = useProfile(accountId);

    if (isLoading && !normalizeDisplayName(nameProp)) {
        return <UserSkeleton variant={variant} size={size} />;
    }

    const resolvedName = resolveUserDisplayName({
        accountId,
        name: nameProp,
        profileName: profile?.name,
        addressBookName: profile?.addressBookName,
        preferAddressBook,
    });

    return (
        <UserWithData
            name={resolvedName}
            address={accountId}
            imageUrl={resolveProfileImageUrl(profile?.image)}
            size={size}
            variant={variant}
            withLink={withLink}
            withHoverCard={withHoverCard}
            chainName={chainName}
            highlightQuery={highlightQuery}
        />
    );
}
