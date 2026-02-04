import { useProfile } from "@/hooks/use-treasury-queries";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Tooltip, TooltipProps } from "./tooltip";
import { Separator } from "./ui/separator";
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
                            className="h-auto w-auto p-0 hover:bg-transparent"
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

export function User({
    accountId,
    iconOnly = false,
    size = "sm",
    withLink = true,
    withName = true,
    withHoverCard = false,
}: UserProps) {
    const { data: profile } = useProfile(withName ? accountId : undefined);
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
