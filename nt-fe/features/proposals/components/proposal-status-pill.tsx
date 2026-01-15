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
            return "bg-green-500/10 text-green-600";
        case "Rejected":
        case "Failed":
        case "Removed":
            return "bg-red-500/10 text-red-600";
        case "InProgress":
        case "Pending":
            return "bg-orange-500/10 text-orange-600";
        case "Expired":
            return "bg-gray-500/10 text-gray-600";
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

export function ProposalStatusPill({ status, className }: ProposalStatusPillProps) {
    const label = getStatusLabel(status);
    return (
        <span
            className={cn(
                "inline-flex px-2 py-1 rounded-md text-xs font-medium",
                getStatusColor(status),
                className
            )}
        >
            {label}
        </span>
    );
}

