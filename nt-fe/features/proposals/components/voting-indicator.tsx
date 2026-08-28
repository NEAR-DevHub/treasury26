import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { getApproversAndThreshold } from "@/lib/config-utils";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import type { Policy } from "@/types/policy";
import {
    getProposalStatus,
    type UIProposalStatus,
} from "../utils/proposal-utils";

interface VotingIndicatorProps {
    proposal: Proposal;
    policy: Policy;
}

/** Approvals already cast take the colour of the request's outcome. */
function approvedIndicatorClass(status: UIProposalStatus) {
    switch (status) {
        case "Executed":
        case "Failed":
            return "bg-general-success-foreground";
        case "Pending":
            return "bg-general-orange-foreground";
        default:
            return "bg-general-unofficial-border-5";
    }
}

/**
 * One bar per required approval — filled bars are the approvals received. The
 * chevron hints that the row expands into the full list of voters.
 */
export function VotingIndicator({ proposal, policy }: VotingIndicatorProps) {
    const { requiredVotes } = getApproversAndThreshold(
        policy,
        "",
        proposal.kind,
        false,
    );
    const status = getProposalStatus(proposal, policy);
    const approvals = Object.values(proposal.votes).filter(
        (vote) => vote === "Approve",
    ).length;
    const indicators = Array.from({ length: requiredVotes }, (_, index) => ({
        id: `approval-${index}`,
        isApproved: index < approvals,
    }));

    return (
        <span className="inline-flex min-h-6 items-center gap-1.5 rounded-lg border border-general-border bg-general-bg-secondary px-2 py-[3px]">
            <span className="flex h-4 items-center gap-1">
                {indicators.map(({ id, isApproved }) => (
                    <span
                        key={id}
                        className={cn(
                            "h-full w-1 rounded-full",
                            isApproved
                                ? approvedIndicatorClass(status)
                                : "bg-general-unofficial-border-3",
                        )}
                    />
                ))}
            </span>
            <span className="text-xs font-semibold leading-[14px] text-general-secondary-foreground">
                {approvals}/{requiredVotes}
            </span>
            <Icon
                icon={ArrowDown01Icon}
                className="size-4 text-general-secondary-foreground"
            />
        </span>
    );
}
