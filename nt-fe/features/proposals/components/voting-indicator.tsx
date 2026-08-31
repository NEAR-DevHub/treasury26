import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Address } from "@/components/address";
import { Icon } from "@/components/icon";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { resolveUserName, UserAvatar } from "@/components/user";
import { useProfile } from "@/hooks/use-treasury-queries";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import type { Proposal, Vote } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import type { Policy } from "@/types/policy";
import {
    getProposalStatus,
    type UIProposalStatus,
} from "../utils/proposal-utils";
import { VoteBadge } from "./proposal-status-pill";

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
 * One of the bars: empty until an account fills it, then tinted by the vote
 * they cast. Rejections are the design's #C2410C wherever the request ends up.
 */
function indicatorClass(vote: Vote | undefined, status: UIProposalStatus) {
    if (!vote) {
        return "bg-general-unofficial-border-3";
    }
    return vote === "Approve"
        ? approvedIndicatorClass(status)
        : "bg-general-orange-foreground";
}

/**
 * The tooltip draws approvals on its own dark surface, where the design's
 * success tint differs from the app-wide dark tokens: #00C076 at 15% behind a
 * #076042 border.
 */
const APPROVED_BADGE_CLASS = "border-[#076042] bg-[#00C076]/15 text-[#00EC97]";

/** One voter in the tooltip: who they are, and the vote they cast. */
function VoterRow({ accountId, vote }: { accountId: string; vote: Vote }) {
    const { data: profile } = useProfile(accountId);
    const name = resolveUserName({ accountId, profile, useAddressBook: true });
    // Without a profile name the second line would repeat the wallet verbatim,
    // so the address moves up into the heading rather than being printed twice.
    const nameIsAddress = name === accountId;

    return (
        <div className="flex items-center gap-3">
            <UserAvatar
                name={name}
                address={accountId}
                imageUrl={resolveProfileImageUrl(profile?.image)}
                // The design gives the tooltip a 28px rounded square, not the
                // circle the inline rows use.
                className="size-7 rounded-sm"
            />
            <div className="flex min-w-0 flex-1 flex-col text-left">
                {!nameIsAddress && (
                    <span className="truncate text-sm font-semibold leading-[1.5]">
                        {name}
                    </span>
                )}
                <Address
                    address={accountId}
                    prefixLength={6}
                    suffixLength={6}
                    className={
                        nameIsAddress
                            ? "text-sm font-semibold leading-[1.5]"
                            : "text-xs leading-4 tracking-[0.18px] text-general-secondary-foreground"
                    }
                />
            </div>
            <VoteBadge
                vote={vote}
                className={cn(
                    "shrink-0 rounded-sm",
                    vote === "Approve" && APPROVED_BADGE_CLASS,
                )}
            />
        </div>
    );
}

/**
 * One bar per vote the threshold needs — filled bars are the votes received,
 * approvals and rejections alike. The chevron hints that the badge opens the
 * list of members who have voted.
 */
export function VotingIndicator({ proposal, policy }: VotingIndicatorProps) {
    const { requiredVotes } = getApproversAndThreshold(
        policy,
        "",
        proposal.kind,
        false,
    );
    const status = getProposalStatus(proposal, policy);
    // Every vote fills a bar, whichever way it was cast. `requiredVotes` is
    // only the approval threshold, so a split vote can push the count past it.
    const votes = Object.entries(proposal.votes);
    const indicators = Array.from({ length: requiredVotes }, (_, index) => ({
        id: `vote-${index}`,
        className: indicatorClass(votes[index]?.[1], status),
    }));

    const badge = (
        <span className="inline-flex min-h-6 items-center gap-1.5 rounded-sm border border-general-border bg-general-bg-secondary px-2 py-[3px]">
            <span className="flex h-4 items-center gap-1">
                {indicators.map(({ id, className }) => (
                    <span
                        key={id}
                        className={cn("h-full w-1 rounded-full", className)}
                    />
                ))}
            </span>
            <span className="text-xs font-semibold leading-[14px] text-general-secondary-foreground">
                {votes.length}/{requiredVotes}
            </span>
            <Icon
                icon={ArrowDown01Icon}
                className="size-4 text-general-secondary-foreground"
            />
        </span>
    );

    // Nobody has voted yet, so there is nothing to list. The badge still renders
    // as a button, which the row's own click handler skips — clicking it opens
    // neither the tooltip nor the details sheet.
    if (votes.length === 0) {
        return (
            <button type="button" className="inline-flex cursor-default">
                {badge}
            </button>
        );
    }

    return (
        <Popover>
            {/* A button, so the row's own click handler leaves it alone. */}
            <PopoverTrigger className="inline-flex cursor-pointer">
                {badge}
            </PopoverTrigger>
            <PopoverContent
                align="start"
                // Tooltips are dark in both themes, and portalled to the body,
                // so `dark` is forced here for the rows to resolve against.
                className="dark flex w-auto max-w-xs flex-col gap-2 rounded-2xl border-transparent bg-general-bg-secondary p-3 text-white shadow-md"
            >
                {votes.map(([voter, vote]) => (
                    <VoterRow key={voter} accountId={voter} vote={vote} />
                ))}
            </PopoverContent>
        </Popover>
    );
}
