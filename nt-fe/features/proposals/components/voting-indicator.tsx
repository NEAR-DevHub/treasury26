import { getApproversAndThreshold } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { Check } from "lucide-react";
import { UserVote } from "./user-vote";
import { getProposalStatus } from "../utils/proposal-utils";

interface VotingIndicatorProps {
    proposal: Proposal;
    policy: Policy;
}

export function VotingIndicator({ proposal, policy }: VotingIndicatorProps) {
    const { requiredVotes } = getApproversAndThreshold(
        policy,
        "",
        proposal.kind,
        false,
    );
    const status = getProposalStatus(proposal, policy);

    const expired = status === "Expired";
    const total = Object.values(proposal.votes).length;

    return (
        <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
                {total} out of {requiredVotes}
            </span>
            <div className="flex">
                {Object.entries(proposal.votes).map(([account, vote]) => {
                    return (
                        <div key={account} className="not-first:-ml-[2px]">
                            <UserVote
                                accountId={account}
                                vote={vote}
                                expired={expired}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
