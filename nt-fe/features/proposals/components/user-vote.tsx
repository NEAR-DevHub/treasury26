import { Button } from "@/components/button";
import { TooltipUser, User } from "@/components/user";
import { Vote } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { Check, Trash, X, } from "lucide-react";

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

    return (
        <TooltipUser accountId={accountId}>
            <Button variant="ghost" size="icon" className="relative m-0">
                <User accountId={accountId} iconOnly={iconOnly} />
                <div className="absolute left-5.5 bottom-1">
                    {icon}
                </div>
            </Button>
        </TooltipUser>
    );
}
