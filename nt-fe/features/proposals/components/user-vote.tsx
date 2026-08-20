import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    Delete01Icon,
    Tick01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { TooltipUser, User } from "@/components/user";
import { Vote } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
const iconStyle = "size-3 text-white rounded-full p-0.5 stroke-3";

export function UserVote({
    accountId,
    vote,
    iconOnly = true,
    expired = false,
}: {
    accountId: string;
    vote: Vote;
    iconOnly?: boolean;
    expired: boolean;
}) {
    let icon;
    let action;
    switch (vote) {
        case "Approve":
            icon = (
                <Icon
                    icon={Tick01Icon}
                    className={cn(
                        iconStyle,
                        "bg-general-success-foreground",
                        expired && "text-white bg-general-unofficial-border-5",
                    )}
                />
            );
            action = "Approved";
            break;
        case "Reject":
            icon = (
                <Icon
                    icon={Cancel01Icon}
                    className={cn(
                        iconStyle,
                        "bg-general-destructive-foreground",
                        expired && "text-white bg-general-unofficial-border-5",
                    )}
                />
            );
            action = "Rejected";
            break;
        case "Remove":
            icon = (
                <Icon
                    icon={Delete01Icon}
                    className={cn(
                        iconStyle,
                        "bg-general-destructive-foreground",
                        expired && "text-white bg-general-unofficial-border-5",
                    )}
                />
            );
            action = "Removed";
            break;
    }

    return (
        <TooltipUser accountId={accountId}>
            <Button
                variant="ghost"
                className={cn(
                    "relative m-0",
                    iconOnly ? "p-0! size-6" : "p-2!",
                )}
            >
                <User
                    accountId={accountId}
                    withLink={false}
                    variant={iconOnly ? "avatar" : "full"}
                />
                <div
                    className={cn(
                        "absolute left-4",
                        iconOnly ? "left-3 -bottom-1" : "left-5.5 bottom-0.5",
                    )}
                >
                    {icon}
                </div>
            </Button>
        </TooltipUser>
    );
}
