"use client";

import { ProposalStatus } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";

interface ProposalStatusPillProps {
    status: string | ProposalStatus;
    className?: string;
}

export function getStatusColor(status: string | ProposalStatus): string {
    switch (status) {
        case "Approved":
        case "Executed":
        case "Paid":
            return "bg-general-success-background-faded text-general-success-foreground";
        case "Rejected":
        case "Failed":
        case "Removed":
            return "bg-general-destructive-background-faded text-general-destructive-foreground";
        case "InProgress":
        case "Pending":
            return "bg-general-orange-background-faded text-general-orange-foreground";
        case "Expired":
            return "bg-secondary text-secondary-foreground";
        default:
            return "bg-muted text-muted-foreground";
    }
}

export function getStatusLabel(status: string | ProposalStatus): string {
    switch (status) {
        case "Approved":
        case "Paid":
            return "Executed";
        case "InProgress":
        case "Pending":
            return "Pending";
        default:
            return status;
    }
}

export function ProposalStatusPill({
    status,
    className,
}: ProposalStatusPillProps) {
    const label = getStatusLabel(status);
    return (
        <span
            className={cn(
                "inline-flex px-2 py-1 rounded-md text-xs font-medium",
                getStatusColor(status),
                className,
            )}
        >
            {label}
        </span>
    );
}
