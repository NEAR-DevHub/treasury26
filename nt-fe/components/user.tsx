import { useProfile } from "@/hooks/use-treasury-queries";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Copy } from "lucide-react";
import { Tooltip } from "./tooltip";
import { TooltipTrigger } from "./ui/tooltip";
import { toast } from "sonner";
import { Separator } from "./ui/separator";

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
}

interface TooltipUserProps {
    accountId: string;
    children: React.ReactNode;
    triggerProps?: Omit<React.ComponentProps<typeof TooltipTrigger>, 'children'>;
}

export function TooltipUser({ accountId, children, triggerProps }: TooltipUserProps) {
    const onCopy = () => {
        navigator.clipboard.writeText(accountId);
        toast.success("Wallet address copied to clipboard");
    }
    return (
        <Tooltip content={<div className="flex flex-col gap-2">
            <User accountId={accountId} size="lg" />
            <Separator className="h-0.5!" />
            <div className="flex items-center gap-2 w-full justify-start cursor-pointer py-1" onClick={onCopy}>
                <Copy className="w-5 h-5 shrink-0" />
                <span className="break-all">Copy Wallet Address</span>
            </div>
        </div>} triggerProps={triggerProps}>
            {children}
        </Tooltip>
    )
}

export function User({ accountId, iconOnly = false, size = "sm", withLink = true, withName = true, withHoverCard = false }: UserProps) {
    const { data: profile } = useProfile(withName ? accountId : undefined);
    const name = profile?.name || accountId.split('.')[0];
    const image = `https://i.near.social/magic/large/https://near.social/magic/img/account/${accountId}`;

    const content = (
        <>
            <div className="rounded-full flex bg-muted border border-border">
                <img src={image} alt="User Logo" className={cn("rounded-full shrink-0", sizeClasses[size])} />
            </div>
            {!iconOnly && (
                <div className="flex flex-col items-start min-w-0">
                    {withName && <span className="font-medium truncate max-w-full">{name}</span>}
                    <span className="text-xs text-muted-foreground truncate max-w-full">{accountId}</span>
                </div>
            )}
        </>
    );

    const userElement = withLink ? (
        <Link href={`https://nearblocks.io/address/${accountId}`} target="_blank" className="flex items-center gap-1.5">
            {content}
        </Link>
    ) : (
        <div className="flex items-center gap-1.5">
            {content}
        </div>
    );

    if (withHoverCard) {
        return <TooltipUser accountId={accountId} triggerProps={{ asChild: false }}>{userElement}</TooltipUser>;
    }

    return userElement;
}
