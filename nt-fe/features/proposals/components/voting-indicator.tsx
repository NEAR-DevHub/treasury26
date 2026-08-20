import { Icon } from "@/components/icon";
import { Tick01Icon } from "@hugeicons/core-free-icons";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
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
    const total = Object.values(proposal.votes).filter(
        (vote) => vote === "Approve",
    ).length;

    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-secondary px-2 py-0.5 rounded-md w-14 justify-center">
                <Icon
                    icon={Tick01Icon}
                    className="text-secondary-foreground stroke-2 shrink-0"
                />
                <span className="text-xs font-medium text-secondary-foreground">
                    {total}/{requiredVotes}
                </span>
            </div>
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
