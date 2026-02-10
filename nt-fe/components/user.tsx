import { useProfile } from "@/hooks/use-treasury-queries";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Tooltip, TooltipProps } from "./tooltip";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import { CopyButton } from "./copy-button";
import { Address } from "./address";

interface UserProps {
    accountId: string;
    iconOnly?: boolean;
    withName?: boolean;
    size?: "sm" | "md" | "lg";
    withLink?: boolean;
    withHoverCard?: boolean;
}

const sizeClasses = {
    sm: "size-6",
    md: "size-8",
    lg: "size-10",
};

interface TooltipUserProps {
    accountId: string;
    children: React.ReactNode;
    triggerProps?: TooltipProps["triggerProps"];
}

export function TooltipUser({
    accountId,
    children,
    triggerProps,
}: TooltipUserProps) {
    return (
        <Tooltip
            content={
                <div className="flex flex-col gap-2">
                    <User accountId={accountId} size="lg" />
                    <Separator className="h-0.5!" />
                    <div className="flex items-center gap-2 w-full justify-start py-1">
                        <CopyButton
                            text={accountId}
                            toastMessage="Wallet address copied to clipboard"
                            variant="ghost"
                            size="icon"
                            className="h-auto w-auto p-0"
                        >
                            <span className="break-all">
                                Copy Wallet Address
                            </span>
                        </CopyButton>
                    </div>
                </div>
            }
            triggerProps={triggerProps}
        >
            {children}
        </Tooltip>
    );
}

const skeletonSizeClasses = {
    sm: { avatar: "size-6", name: "h-3.5 w-20", address: "h-3 w-24" },
    md: { avatar: "size-8", name: "h-4 w-24", address: "h-3 w-28" },
    lg: { avatar: "size-10", name: "h-4 w-28", address: "h-3.5 w-32" },
};

export function UserSkeleton({
    iconOnly = false,
    size = "sm",
    withName = true,
}: Pick<UserProps, "iconOnly" | "size" | "withName">) {
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

export function User({
    accountId,
    iconOnly = false,
    size = "sm",
    withLink = true,
    withName = true,
    withHoverCard = false,
}: UserProps) {
    const { data: profile, isLoading } = useProfile(
        withName ? accountId : undefined,
    );

    if (isLoading) {
        return (
            <UserSkeleton iconOnly={iconOnly} size={size} withName={withName} />
        );
    }

    const image = `https://i.near.social/magic/large/https://near.social/magic/img/account/${accountId}`;

    const name = profile?.name ? (
        <span className="font-medium truncate max-w-full">{profile.name}</span>
    ) : (
        <Address
            address={accountId}
            className="font-medium truncate max-w-full"
        />
    );

    const content = (
        <>
            <div className="rounded-full flex bg-muted border border-border">
                <img
                    src={image}
                    alt="User Logo"
                    className={cn("rounded-full shrink-0", sizeClasses[size])}
                />
            </div>
            {!iconOnly && (
                <div className="flex flex-col items-start min-w-0">
                    {withName && name}
                    <Address
                        address={accountId}
                        className="text-xs text-muted-foreground truncate max-w-full"
                    />
                </div>
            )}
        </>
    );

    const userElement = withLink ? (
        <Link
            href={`https://nearblocks.io/address/${accountId}`}
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
                accountId={accountId}
                triggerProps={{ asChild: false }}
            >
                {userElement}
            </TooltipUser>
        );
    }

    return userElement;
}
