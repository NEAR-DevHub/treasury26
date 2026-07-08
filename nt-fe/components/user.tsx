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
import { getExplorerAddressUrl } from "@/lib/blockchain-utils";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

// ─── Shared types ─────────────────────────────────────────────────────────────

export const sizeClasses = {
    sm: "size-6",
    md: "size-8",
    lg: "size-10",
} as const;

type UserSize = keyof typeof sizeClasses;

const avatarTextSizeClasses = {
    sm: "text-[10px]",
    md: "text-xs",
    lg: "text-sm",
} as const;

function getUserAvatarInitial(name: string, address: string): string {
    if (name && name !== address) {
        return name.charAt(0).toUpperCase();
    }
    return address.charAt(0).toLowerCase();
}

function resolveProfileImageUrl(image: unknown): string | undefined {
    if (!image) return undefined;

    if (typeof image === "string") {
        const trimmed = image.trim();
        return trimmed || undefined;
    }

    if (typeof image === "object") {
        const value = image as Record<string, unknown>;
        if (typeof value.url === "string" && value.url.trim()) {
            return value.url.trim();
        }

        const cid = value.ipfs_cid ?? value.ipfsCid;
        if (typeof cid === "string" && cid.trim()) {
            return `https://ipfs.near.social/ipfs/${cid.trim()}`;
        }
    }

    return undefined;
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
    iconOnly = false,
    size = "sm",
    withName = true,
}: {
    iconOnly?: boolean;
    size?: UserSize;
    withName?: boolean;
}) {
    const s = skeletonSizeClasses[size];
    return (
        <div className="flex items-center gap-1.5">
            <Skeleton className={cn("rounded-full shrink-0", s.avatar)} />
            {!iconOnly && (
                <div className="flex flex-col items-start gap-1 min-w-0">
                    {withName && <Skeleton className={s.name} />}
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
    iconOnly?: boolean;
    truncatePrimaryAddress?: boolean;
    size?: UserSize;
    withLink?: boolean;
    withHoverCard?: boolean;
    chainName?: string;
    useAddressBook?: boolean;
}

export function UserWithData({
    name,
    address,
    imageUrl,
    size = "sm",
    iconOnly = false,
    truncatePrimaryAddress = false,
    withLink = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
    useAddressBook = false,
}: UserWithDataProps) {
    const explorerUrl = getExplorerAddressUrl(chainName, address);

    const content = (
        <>
            <UserAvatar
                name={name}
                address={address}
                imageUrl={imageUrl}
                size={size}
            />
            {!iconOnly && (
                <div className="flex flex-col items-start max-w-60 md:max-w-80 min-w-0">
                    {truncatePrimaryAddress && name === address ? (
                        <Address
                            address={address}
                            className="font-medium max-w-full text-sm"
                        />
                    ) : (
                        <span className="font-medium truncate max-w-full text-sm">
                            {name}
                        </span>
                    )}
                    <Address
                        address={address}
                        className="text-xs text-muted-foreground truncate max-w-full"
                    />
                </div>
            )}
        </>
    );

    const userElement =
        withLink && explorerUrl ? (
            <Link
                href={explorerUrl}
                target="_blank"
                className="flex items-center gap-1.5"
            >
                {content}
            </Link>
        ) : (
            <div className="flex items-center gap-1.5">{content}</div>
        );

    if (withHoverCard) {
        return (
            <TooltipUser
                accountId={address}
                name={name}
                chainName={chainName}
                useAddressBook={useAddressBook}
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
    chainName?: string;
    useAddressBook?: boolean;
    children: React.ReactNode;
    triggerProps?: TooltipProps["triggerProps"];
}

export function TooltipUser({
    accountId,
    name,
    chainName = NEAR_NETWORK_ID,
    useAddressBook = false,
    children,
    triggerProps,
}: TooltipUserProps) {
    const t = useTranslations("user");
    const { treasuryId, isGuestTreasury } = useTreasury();
    const { data: profile, isLoading: isProfileLoading } =
        useProfile(accountId);
    const isSavedInAddressBook = profile?.isInAddressBook ?? false;
    const addressBookParams = new URLSearchParams({
        name: name ?? profile?.name ?? accountId,
        address: accountId,
    });
    addressBookParams.set("network", chainName);

    const addToAddressBookUrl = treasuryId
        ? `/${treasuryId}/address-book?${addressBookParams.toString()}`
        : null;

    return (
        <Tooltip
            content={
                <div className="flex flex-col gap-2">
                    <User
                        accountId={accountId}
                        name={name}
                        useAddressBook={useAddressBook}
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
                            text={accountId}
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
    /** Prefer treasury address-book name when available */
    useAddressBook?: boolean;
    iconOnly?: boolean;
    /** Use address-style truncation for the primary line when name equals address */
    truncatePrimaryAddress?: boolean;
    withName?: boolean;
    size?: UserSize;
    withLink?: boolean;
    withHoverCard?: boolean;
    chainName?: string;
}

export function User({
    accountId,
    name: nameProp,
    useAddressBook = false,
    iconOnly = false,
    truncatePrimaryAddress = false,
    size = "sm",
    withLink = true,
    withName = true,
    withHoverCard = false,
    chainName = NEAR_NETWORK_ID,
}: UserProps) {
    const { data: profile, isLoading } = useProfile(accountId);

    if (isLoading && withName && !nameProp) {
        return (
            <UserSkeleton iconOnly={iconOnly} size={size} withName={withName} />
        );
    }

    const resolvedName =
        nameProp ??
        (useAddressBook
            ? (profile?.addressBookName ?? profile?.name)
            : profile?.name) ??
        accountId;

    return (
        <UserWithData
            name={resolvedName}
            address={accountId}
            imageUrl={resolveProfileImageUrl(profile?.image)}
            useAddressBook={useAddressBook}
            size={size}
            iconOnly={iconOnly}
            truncatePrimaryAddress={truncatePrimaryAddress}
            withLink={withLink}
            withHoverCard={withHoverCard}
            chainName={chainName}
        />
    );
}
