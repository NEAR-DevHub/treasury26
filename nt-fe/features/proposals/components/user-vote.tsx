import { Tooltip } from "@/components/tooltip";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { User } from "@/components/user";
import { Vote } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { Check, Copy, Trash, X, } from "lucide-react";
import { toast } from "sonner";

const iconStyle = "size-3 text-white rounded-full p-0.5 stroke-3";

export function UserVote({ accountId, vote, iconOnly = true }: { accountId: string, vote: Vote, iconOnly?: boolean }) {
    let icon;
    let action;
    switch (vote) {
        case "Approve":
            icon = <Check className={cn(iconStyle, "bg-green-500")} />;
            action = "Approved";
            break;
        case "Reject":
            icon = <X className={cn(iconStyle, "bg-red-500")} />;
            action = "Rejected";
            break;
        case "Remove":
            icon = <Trash className={cn(iconStyle, "bg-red-500")} />;
            action = "Removed";
            break;
    }

    const onCopy = () => {
        navigator.clipboard.writeText(accountId);
        toast.success("Wallet address copied to clipboard");
    }

    return (
        <Tooltip content={<div className="flex flex-col gap-2">
            <User accountId={accountId} />
            <Separator />
            <Button variant="ghost" size="sm" className="w-full">
                <Copy className="w-4 h-4" />
                Copy Wallet Address
            </Button>

        </div>}>
            <Button variant="ghost" size={"sm"} className="relative p-2 m-0">
                <User accountId={accountId} iconOnly={iconOnly} />
                <div className="absolute left-5.5 bottom-0.5">
                    {icon}
                </div>
            </Button>
        </Tooltip>
    );
}
