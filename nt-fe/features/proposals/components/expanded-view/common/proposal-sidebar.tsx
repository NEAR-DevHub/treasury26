import { Proposal } from "@/lib/proposals-api";
import { Button } from "@/components/button";
import { ArrowUpRight, Check, X, Download } from "lucide-react";
import { PageCard } from "@/components/card";
import { Policy } from "@/types/policy";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import {
    getProposalStatus,
    UIProposalStatus,
    getProposalUIKind,
    EXCHANGE_EXPIRY_MS,
} from "@/features/proposals/utils/proposal-utils";
import { useProposalInsufficientBalance } from "@/features/proposals/hooks/use-proposal-insufficient-balance";
import { UserVote } from "../../user-vote";
import { useProposalTransaction, useSwapStatus } from "@/hooks/use-proposals";
import Link from "next/link";
import Big from "big.js";
import { User } from "@/components/user";
import {
    AuthButtonWithProposal,
    NO_VOTE_MESSAGE,
} from "@/components/auth-button";
import { useFormatDate } from "@/components/formatted-date";
import { InfoAlert } from "@/components/info-alert";
import { cn } from "@/lib/utils";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import { NotEnoughBalance } from "../../not-enough-balance";

interface ProposalSidebarProps {
    proposal: Proposal;
    policy: Policy;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

interface StepIconProps {
    status: "Success" | "Pending" | "Failed" | "Expired";
    size?: "sm" | "md";
}

const sizeClass = {
    sm: "size-4",
    md: "size-6",
};

const iconClass = {
    sm: "size-3",
    md: "size-4",
};
export function StepIcon({ status, size = "md" }: StepIconProps) {
    switch (status) {
        case "Success":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-general-success-foreground",
                        sizeClass[size],
                    )}
                >
                    <Check
                        className={cn(iconClass[size], "text-white shrink-0")}
                    />
                </div>
            );
        case "Pending":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full border border-muted-foreground/20 bg-card",
                        sizeClass[size],
                    )}
                />
            );
        case "Expired":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-secondary",
                        sizeClass[size],
                    )}
                >
                    <X
                        className={cn(
                            iconClass[size],
                            "text-muted-foreground shrink-0",
                        )}
                    />
                </div>
            );
        case "Failed":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-general-destructive-foreground",
                        sizeClass[size],
                    )}
                >
                    <X className={cn(iconClass[size], "text-white shrink-0")} />
                </div>
            );
    }
}

function TransactionCreated({
    proposer,
    date,
}: {
    proposer: string;
    date: Date;
}) {
    const formatDate = useFormatDate();

    return (
        <div className="flex flex-col gap-3 relative z-10">
            <div className="flex items-center gap-2">
                <StepIcon status="Success" />
                <div className="flex flex-col gap-0">
                    <p className="text-sm font-semibold">Transaction Created</p>
                    {date && (
                        <p className="text-xs text-muted-foreground">
                            {formatDate(date)}
                        </p>
                    )}
                </div>
            </div>
            <div className="ml-5">
                <User accountId={proposer} withName={true} />
            </div>
        </div>
    );
}

function VotingSection({
    proposal,
    policy,
    accountId,
}: {
    proposal: Proposal;
    policy: Policy;
    accountId: string;
}) {
    const votes = proposal.votes;

    const totalApprovesReceived = Object.values(votes).filter(
        (vote) => vote === "Approve",
    ).length;
    const { requiredVotes } = getApproversAndThreshold(
        policy,
        accountId ?? "",
        proposal.kind,
        false,
    );
    const votesArray = Object.entries(votes);

    let proposalStatus = getProposalStatus(proposal, policy);
    let statusIconStatus: "Pending" | "Failed" | "Success" = "Pending";
    if (proposalStatus === "Executed" || proposalStatus === "Failed") {
        statusIconStatus = "Success";
    }

    return (
        <div className="flex flex-col gap-3 relative z-10">
            <div className="flex items-center gap-2">
                <StepIcon status={statusIconStatus} />
                <div>
                    <p className="text-sm font-semibold">Voting</p>
                    <p className="text-xs text-muted-foreground">
                        {totalApprovesReceived}/{requiredVotes} approvals
                        received
                    </p>
                </div>
            </div>

            <div className="ml-5 flex flex-col gap-1">
                {votesArray.map(([account, vote]) => {
                    return (
                        <div key={account} className="flex items-center gap-2">
                            <UserVote
                                accountId={account}
                                vote={vote}
                                iconOnly={false}
                                expired={proposalStatus === "Expired"}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ExecutedSection({
    status,
    date,
    expiresAt,
}: {
    status: UIProposalStatus;
    date?: Date;
    expiresAt: Date;
}) {
    const formatDate = useFormatDate();

    let statusIcon = <StepIcon status="Pending" />;
    let statusText = status as string;

    switch (status) {
        case "Pending":
            statusText = "Expires At";
            break;
        case "Rejected":
        case "Failed":
        case "Removed":
            statusIcon = <StepIcon status="Failed" />;
            break;
        case "Expired":
            statusText = "Expired At";
            statusIcon = <StepIcon status="Expired" />;
            break;
        case "Executed":
            statusIcon = <StepIcon status="Success" />;
            break;
    }

    return (
        <div className="space-y-3 relative z-10">
            <div className="flex items-center gap-2">
                {statusIcon}
                <div className="flex flex-col gap-0">
                    <p className="text-sm font-semibold">{statusText}</p>
                    <p className="text-xs text-muted-foreground">
                        {formatDate(date ?? expiresAt)}
                    </p>
                </div>
            </div>
        </div>
    );
}

export function ProposalSidebar({
    proposal,
    policy,
    onVote,
    onDeposit,
}: ProposalSidebarProps) {
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );

    const status = getProposalStatus(proposal, policy);
    const isUserVoter = !!proposal.votes[accountId ?? ""];
    const isPending = status === "Pending";
    const proposalType = getProposalUIKind(proposal);
    const isExchangeProposal = proposalType === "Exchange";
    const isFailed = status === "Failed";
    const isExecuted = status === "Executed";

    // Extract deposit address for exchange proposals
    let depositAddress: string | undefined;
    if (isExchangeProposal) {
        try {
            const { data } = extractProposalData(proposal);
            depositAddress = (data as any).depositAddress;
        } catch (e) {
        }
    }

    // Fetch transaction data for non-exchange proposals, or for failed exchange proposals
    const { data: transaction } = useProposalTransaction(
        treasuryId,
        proposal,
        policy,
        !isExchangeProposal || isFailed
    );

    // Fetch swap status for executed exchange proposals
    const { data: swapStatus } = useSwapStatus(
        depositAddress || null,
        undefined,
        isExchangeProposal && isExecuted && !!depositAddress
    );

    const expiresAt = new Date(
        Big(proposal.submission_time)
            .add(policy.proposal_period)
            .div(1000000)
            .toNumber(),
    );

    // For exchange proposals, calculate 24-hour expiration
    const exchange24HourExpiry = isExchangeProposal
        ? new Date(
            Big(proposal.submission_time).div(1000000).toNumber() +
            EXCHANGE_EXPIRY_MS,
        )
        : null;

    let timestamp;
    switch (status) {
        case "Expired":
        case "Pending":
            // Use 24-hour expiry for exchange proposals, otherwise use policy period
            timestamp = (isExchangeProposal && exchange24HourExpiry) ? exchange24HourExpiry : expiresAt;
            break;

        default:
            timestamp = transaction?.timestamp
                ? new Date(transaction.timestamp / 1000000)
                : undefined;
            break;
    }

    return (
        <PageCard className="relative w-full">
            <div className="relative flex flex-col gap-4">
                <TransactionCreated
                    proposer={proposal.proposer}
                    date={
                        new Date(
                            Big(proposal.submission_time)
                                .div(1000000)
                                .toNumber(),
                        )
                    }
                />
                <VotingSection
                    proposal={proposal}
                    policy={policy}
                    accountId={accountId ?? ""}
                />
                <ExecutedSection
                    status={status}
                    date={timestamp}
                    expiresAt={expiresAt}
                />
                <div className="absolute left-[11px] top-1 bottom-2 w-px bg-muted-foreground/20" />
            </div>

            {/* Transaction Links */}
            {(isExecuted || isFailed) && (
                <>
                    {/* For exchange proposals, show intents explorer link */}
                    {!isFailed && isExchangeProposal && depositAddress ? (
                        <Link
                            href={`https://explorer.near-intents.org/transactions/${depositAddress}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex font-medium text-sm items-center gap-1.5"
                        >
                            View Transaction <ArrowUpRight className="size-4" />
                        </Link>
                    ) : (
                        /* For other proposals, show regular transaction link */
                        transaction && (
                            <Link
                                href={transaction.nearblocks_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex font-medium text-sm items-center gap-1.5"
                            >
                                View Transaction <ArrowUpRight className="size-4" />
                            </Link>
                        )
                    )}
                </>
            )}

            {/* Exchange Swap Status - Show for executed exchange proposals */}
            {isExecuted && isExchangeProposal && swapStatus && (
                <>
                    {(swapStatus.status === "KNOWN_DEPOSIT_TX" ||
                        swapStatus.status === "PENDING_DEPOSIT" ||
                        swapStatus.status === "INCOMPLETE_DEPOSIT" ||
                        swapStatus.status === "PROCESSING") && (
                            <InfoAlert
                                className="inline-flex"
                                message={
                                    <span>
                                        <strong>Exchanging Tokens</strong>
                                        <br />
                                        This request has been approved by the team. Token
                                        exchange is now in progress and may take some time.
                                    </span>
                                }
                            />
                        )}

                    {/* Failed/Refunded Status */}
                    {(swapStatus.status === "FAILED" || swapStatus.status === "REFUNDED") && (
                        <InfoAlert
                            className="inline-flex"
                            message={
                                <span>
                                    <strong>Request Failed</strong>
                                    <br />
                                    The team approved this request, but it failed due to rate fluctuations. Please create a new request and try again.
                                </span>
                            }
                        />
                    )}
                </>
            )}

            {/* Exchange Proposal 24-Hour Warning */}
            {isPending && isExchangeProposal && exchange24HourExpiry && (
                <InfoAlert
                    className="inline-flex"
                    message={
                        <span>
                            <strong>Voting period: 24 hours</strong>
                            <br />
                            This exchange request has a 24-hour voting duration.
                            Approve this request within this time, or the request
                            will expire.
                        </span>
                    }
                />
            )}

            {/* Insufficient Balance Warning */}
            {isPending && (
                <NotEnoughBalance
                    insufficientBalanceInfo={insufficientBalanceInfo}
                />
            )}

            {/* Action Buttons */}
            {isPending && (
                <div className="flex gap-2">
                    <AuthButtonWithProposal
                        proposalKind={proposal.kind}
                        variant="secondary"
                        className="flex-1"
                        onClick={() => onVote("Reject")}
                        disabled={isUserVoter}
                        tooltip={isUserVoter ? NO_VOTE_MESSAGE : undefined}
                    >
                        <X className="h-4 w-4 mr-2" />
                        Reject
                    </AuthButtonWithProposal>
                    {insufficientBalanceInfo.hasInsufficientBalance ? (
                        <Button
                            variant="default"
                            className="flex gap-1 flex-1"
                            onClick={() =>
                                onDeposit(
                                    insufficientBalanceInfo.tokenSymbol,
                                    insufficientBalanceInfo.tokenNetwork,
                                )
                            }
                        >
                            <Download className="h-4 w-4 mr-2" />
                            Deposit
                        </Button>
                    ) : (
                        <AuthButtonWithProposal
                            proposalKind={proposal.kind}
                            variant="default"
                            className="flex gap-1 flex-1"
                            onClick={() => onVote("Approve")}
                            disabled={isUserVoter}
                            tooltip={isUserVoter ? NO_VOTE_MESSAGE : undefined}
                        >
                            <Check className="h-4 w-4 mr-2" />
                            Approve
                        </AuthButtonWithProposal>
                    )}
                </div>
            )}
        </PageCard>
    );
}
