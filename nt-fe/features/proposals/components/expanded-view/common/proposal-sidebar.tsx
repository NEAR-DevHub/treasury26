import { useTranslations } from "next-intl";
import { Proposal } from "@/lib/proposals-api";
import { Button } from "@/components/button";
import {
    SquareArrowOutUpRight,
    Check,
    X,
    Download,
    Loader2,
    FileText,
} from "lucide-react";
import { PageCard } from "@/components/card";
import { Policy } from "@/types/policy";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import {
    EXCHANGE_EXPIRY_MS,
    getProposalStatus,
    getProposalUIKind,
    UIProposalStatus,
    getProposalStatusDateInfo,
    isShortExpiryExchangeProposal,
} from "@/features/proposals/utils/proposal-utils";
import { useProposalInsufficientBalance } from "@/features/proposals/hooks/use-proposal-insufficient-balance";
import { UserVote } from "../../user-vote";
import {
    useProposalTransaction,
    useSwapStatus,
    useProposals,
} from "@/hooks/use-proposals";
import Link from "next/link";
import Big from "@/lib/big";
import { User } from "@/components/user";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { useFormatDate } from "@/components/formatted-date";
import { InfoAlert } from "@/components/info-alert";
import { StepIcon } from "@/components/step-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, nanosToMs } from "@/lib/utils";
import {
    extractReceiptProposalData,
    getProposalExecutedDate,
    isReceiptEligibleProposalKind,
} from "@/features/proposals/utils/receipt-utils";
import { NotEnoughBalance } from "../../not-enough-balance";
import { VotingDurationImpactModal } from "../../voting-duration-impact-modal";
import { useState, useEffect } from "react";

interface ProposalSidebarProps {
    proposal: Proposal;
    policy: Policy;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

function TransactionCreated({
    proposer,
    date,
}: {
    proposer: string;
    date: Date;
}) {
    const t = useTranslations("proposals.expanded");
    const formatDate = useFormatDate();

    return (
        <div className="flex flex-col gap-3 relative z-10">
            <div className="flex items-center gap-2">
                <StepIcon status="Success" />
                <div className="flex flex-col gap-0">
                    <p className="text-sm font-semibold">
                        {t("transactionCreated")}
                    </p>
                    {date && (
                        <p className="text-xs text-muted-foreground">
                            {formatDate(date)}
                        </p>
                    )}
                </div>
            </div>
            <div className="ml-5">
                <User
                    accountId={proposer}
                    withName={true}
                    withHoverCard
                    withLink={false}
                />
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
    const t = useTranslations("proposals.expanded");
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

    const proposalStatus = getProposalStatus(proposal, policy);
    let statusIconStatus: "Pending" | "Failed" | "Success" = "Pending";
    if (proposalStatus === "Executed" || proposalStatus === "Failed") {
        statusIconStatus = "Success";
    }

    return (
        <div className="flex flex-col gap-3 relative z-10">
            <div className="flex items-center gap-2">
                <StepIcon status={statusIconStatus} />
                <div>
                    <p className="text-sm font-semibold">{t("voting")}</p>
                    <p className="text-xs text-muted-foreground">
                        {t("approvalsReceived", {
                            received: totalApprovesReceived,
                            required: requiredVotes,
                        })}
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
    isDateLoading = false,
}: {
    status: UIProposalStatus;
    date?: Date;
    expiresAt: Date;
    isDateLoading?: boolean;
}) {
    const t = useTranslations("proposals.expanded");
    const tStatus = useTranslations("proposals.status");
    const formatDate = useFormatDate();

    let statusIcon = <StepIcon status="Pending" />;
    let statusText: string;
    switch (status) {
        case "Pending":
            statusText = t("expiresAt");
            break;
        case "Rejected":
            statusText = tStatus("rejected");
            statusIcon = <StepIcon status="Failed" />;
            break;
        case "Failed":
            statusText = tStatus("failed");
            statusIcon = <StepIcon status="Failed" />;
            break;
        case "Removed":
            statusText = tStatus("removed");
            statusIcon = <StepIcon status="Failed" />;
            break;
        case "Expired":
            statusText = t("expiredAt");
            statusIcon = <StepIcon status="Expired" />;
            break;
        case "Executed":
            statusText = tStatus("executed");
            statusIcon = <StepIcon status="Success" />;
            break;
        default:
            statusText = status as string;
    }

    return (
        <div className="space-y-3 relative z-10">
            <div className="flex items-center gap-2">
                {statusIcon}
                <div className="flex flex-col gap-0">
                    <p className="text-sm font-semibold">{statusText}</p>
                    <p className="text-xs text-muted-foreground">
                        {isDateLoading ? (
                            <Skeleton className="h-4 w-36" />
                        ) : (
                            formatDate(date ?? expiresAt)
                        )}
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
    const t = useTranslations("proposals.expanded");
    const tReceipt = useTranslations("receiptPage");
    const noVoteMessage = useNoVoteMessage();
    const { accountId } = useNear();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );

    const [showVotingDurationModal, setShowVotingDurationModal] =
        useState(false);
    const [isCheckingVotingDurationImpact, setIsCheckingVotingDurationImpact] =
        useState(false);

    // Check if this is a voting duration change proposal
    const isVotingDurationChange =
        "ChangePolicyUpdateParameters" in proposal.kind;

    // Fetch active proposals only when needed for voting duration impact check
    const { data: allProposalsData, isLoading: isLoadingProposals } =
        useProposals(
            treasuryId,
            {
                statuses: ["InProgress", "Expired"],
                page_size: 100,
            },
            isVotingDurationChange,
        );
    const status = getProposalStatus(proposal, policy);
    const proposalType = getProposalUIKind(proposal);
    const isUserVoter = !!proposal.votes[accountId ?? ""];
    const isPending = status === "Pending";
    const isExecuted = status === "Executed";
    const isBatchPaymentProposal = proposalType === "Batch Payment Request";
    const isConfidentialRequestProposal =
        proposalType === "Confidential Request";
    const isReceiptEligibleKind = isReceiptEligibleProposalKind(proposalType);

    let newVotingDurationDays = 0;
    if (isVotingDurationChange) {
        const params = (proposal.kind as any).ChangePolicyUpdateParameters
            ?.parameters;
        if (params?.proposal_period) {
            newVotingDurationDays = Math.floor(
                nanosToMs(params.proposal_period) / (24 * 60 * 60 * 1000),
            );
        }
    }

    const receiptProposalData = extractReceiptProposalData(
        proposal,
        treasuryId,
    );
    const depositAddress = receiptProposalData?.depositAddress;
    const isPaymentLikeProposal = receiptProposalData?.variant === "payment";

    // Whether this proposal used the Intents protocol (has a deposit address)
    const hasDepositAddress = !!depositAddress;
    const shouldUseTransactionDate = isExecuted;
    const shouldUseSwapDate = isExecuted && hasDepositAddress;

    // Fetch transaction data for non-intents proposals, or for statuses
    // whose resolved date/link should come from the chain transaction.
    const { data: transaction, isLoading: isLoadingTransaction } =
        useProposalTransaction(
            treasuryId,
            proposal,
            policy,
            shouldUseTransactionDate &&
                (!hasDepositAddress || !shouldUseSwapDate),
        );

    // Fetch swap status for executed intents proposals (exchange or payment)
    const { data: swapStatus, isLoading: isLoadingSwapStatus } = useSwapStatus(
        depositAddress || null,
        undefined,
        shouldUseSwapDate,
    );
    const shouldRequireSwapSuccess =
        hasDepositAddress && !isConfidentialRequestProposal;
    const isSwapSuccessReady = shouldRequireSwapSuccess
        ? swapStatus?.status === "SUCCESS"
        : true;
    const isHidden = isConfidential && isGuestTreasury;
    // Receipt button visibility rules:
    // - Proposal must be executed and of a receipt-eligible kind.
    // - For intents-routed proposals (with depositAddress), swap status must be SUCCESS.
    // - Batch receipts are hidden for confidential treasuries.
    // - Hidden (guest) confidential treasuries cannot generate receipts.
    const canShowReceiptButton =
        isExecuted &&
        !isHidden &&
        isReceiptEligibleKind &&
        isSwapSuccessReady &&
        (isBatchPaymentProposal
            ? !isConfidential
            : isConfidentialRequestProposal || receiptProposalData !== null);

    const expiresAt = new Date(
        nanosToMs(
            Big(proposal.submission_time)
                .add(policy.proposal_period)
                .toFixed(0),
        ),
    );
    const statusDateInfo = getProposalStatusDateInfo(proposal, policy);
    const shortExpiryExchange =
        isShortExpiryExchangeProposal(proposal) &&
        nanosToMs(policy.proposal_period) > EXCHANGE_EXPIRY_MS;

    const timestamp = shouldUseTransactionDate
        ? (getProposalExecutedDate(swapStatus, transaction) ?? undefined)
        : statusDateInfo.date;
    const shouldShowResolvedDate = status !== "Pending" && status !== "Expired";
    const resolvesDateFromTransaction = shouldUseTransactionDate;
    const isResolvedDateLoading =
        shouldShowResolvedDate && resolvesDateFromTransaction
            ? shouldUseSwapDate
                ? isLoadingSwapStatus
                : isLoadingTransaction
            : false;

    const isLastApprovingVote = () => {
        const currentApprovals = Object.values(proposal.votes).filter(
            (v) => v === "Approve",
        ).length;
        const { requiredVotes } = getApproversAndThreshold(
            policy,
            accountId ?? "",
            proposal.kind,
            false,
        );
        return requiredVotes !== null && currentApprovals + 1 >= requiredVotes;
    };

    // When proposals finish loading after user clicked Approve, open the modal
    useEffect(() => {
        if (isCheckingVotingDurationImpact && !isLoadingProposals) {
            setIsCheckingVotingDurationImpact(false);
            setShowVotingDurationModal(true);
        }
    }, [isCheckingVotingDurationImpact, isLoadingProposals]);

    // Handle approve with voting duration check
    const handleApprove = () => {
        if (
            isVotingDurationChange &&
            newVotingDurationDays > 0 &&
            isLastApprovingVote()
        ) {
            setIsCheckingVotingDurationImpact(true);
            if (isLoadingProposals) {
                return;
            } else {
                setIsCheckingVotingDurationImpact(false);
                setShowVotingDurationModal(true);
            }
        } else {
            onVote("Approve");
        }
    };

    const handleVotingDurationApprove = () => {
        setShowVotingDurationModal(false);
        setIsCheckingVotingDurationImpact(false);
        onVote("Approve");
    };

    const handleVotingDurationClose = () => {
        setShowVotingDurationModal(false);
        setIsCheckingVotingDurationImpact(false);
    };

    // Impact proposals: exclude current proposal and contract-expired items
    const activeProposals =
        allProposalsData?.proposals?.filter(
            (p: Proposal) => p.id !== proposal.id && p.status === "InProgress",
        ) ?? [];

    return (
        <PageCard className="relative w-full">
            <div className="relative flex flex-col gap-4">
                <TransactionCreated
                    proposer={proposal.proposer}
                    date={new Date(nanosToMs(proposal.submission_time))}
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
                    isDateLoading={isResolvedDateLoading}
                />
                <div className="absolute left-[11px] top-1 bottom-2 w-px bg-muted-foreground/20" />
            </div>

            {/* Transaction Links */}
            {isExecuted && (
                <div className="flex flex-col gap-2">
                    {canShowReceiptButton && (
                        <Button asChild variant="secondary" className="w-full">
                            <Link
                                href={`/${treasuryId}/requests/${proposal.id}/receipt`}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <FileText className="size-4" />
                                {tReceipt("generateReceipt")}
                            </Link>
                        </Button>
                    )}
                    {/* For intents-routed proposals (exchange or payment), show intents explorer link */}
                    {isExecuted && hasDepositAddress ? (
                        <Link
                            href={`https://explorer.near-intents.org/transactions/${depositAddress}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex font-medium text-sm items-center justify-center gap-1.5 text-foreground"
                        >
                            <SquareArrowOutUpRight className="size-4" />
                            {t("viewTransaction")}
                        </Link>
                    ) : (
                        /* For other proposals, show regular transaction link */
                        transaction && (
                            <Link
                                href={transaction.nearblocks_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex font-medium text-sm items-center justify-center gap-1.5 text-foreground"
                            >
                                <SquareArrowOutUpRight className="size-4" />
                                {t("viewTransaction")}
                            </Link>
                        )
                    )}
                </div>
            )}

            {/* Swap Status - Show for executed intents-routed proposals (exchange or payment) */}
            {isExecuted && hasDepositAddress && swapStatus && (
                <>
                    {(swapStatus.status === "KNOWN_DEPOSIT_TX" ||
                        swapStatus.status === "PENDING_DEPOSIT" ||
                        swapStatus.status === "INCOMPLETE_DEPOSIT" ||
                        swapStatus.status === "PROCESSING") && (
                        <InfoAlert
                            className="inline-flex"
                            message={
                                <span>
                                    <strong>
                                        {isPaymentLikeProposal
                                            ? t("processingPayment")
                                            : t("exchangingTokens")}
                                    </strong>
                                    <br />
                                    {isPaymentLikeProposal
                                        ? t("processingPaymentBody")
                                        : t("exchangingTokensBody")}
                                </span>
                            }
                        />
                    )}

                    {/* Failed/Refunded Status */}
                    {(swapStatus.status === "FAILED" ||
                        swapStatus.status === "REFUNDED") && (
                        <InfoAlert
                            className="inline-flex"
                            message={
                                <span>
                                    <strong>{t("requestFailed")}</strong>
                                    <br />
                                    {t("requestFailedBody")}
                                </span>
                            }
                        />
                    )}
                </>
            )}

            {/* Short-Expiry Warning (exchange proposals only) */}
            {isPending && shortExpiryExchange && (
                <InfoAlert
                    className="inline-flex"
                    message={
                        <span>
                            <strong>{t("votingPeriod24h")}</strong>
                            <br />
                            {t("votingPeriod24hBody")}
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
                        className="flex gap-1 w-full"
                        onClick={() => onVote("Reject")}
                        disabled={isUserVoter}
                        tooltip={isUserVoter ? noVoteMessage : undefined}
                    >
                        <X className="h-4 w-4 mr-2" />
                        {t("reject")}
                    </AuthButtonWithProposal>
                    {insufficientBalanceInfo.hasInsufficientBalance ? (
                        <span className="w-full">
                            <Button
                                variant="default"
                                className="flex gap-1 w-full"
                                onClick={() =>
                                    onDeposit(
                                        insufficientBalanceInfo.tokenSymbol,
                                        insufficientBalanceInfo.tokenNetwork,
                                    )
                                }
                            >
                                <Download className="h-4 w-4 mr-2" />
                                {t("deposit")}
                            </Button>
                        </span>
                    ) : (
                        <AuthButtonWithProposal
                            proposalKind={proposal.kind}
                            variant="default"
                            className="flex gap-1 w-full"
                            onClick={handleApprove}
                            disabled={
                                isUserVoter || isCheckingVotingDurationImpact
                            }
                            tooltip={isUserVoter ? noVoteMessage : undefined}
                        >
                            {isCheckingVotingDurationImpact ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                                <Check className="h-4 w-4 mr-2" />
                            )}
                            {t("approve")}
                        </AuthButtonWithProposal>
                    )}
                </div>
            )}

            {/* Voting Duration Impact Modal */}
            {isVotingDurationChange && (
                <VotingDurationImpactModal
                    isOpen={showVotingDurationModal}
                    onClose={handleVotingDurationClose}
                    onConfirm={handleVotingDurationApprove}
                    onNoImpactedProposals={handleVotingDurationApprove}
                    newDurationDays={newVotingDurationDays}
                    currentPolicy={policy}
                    activeProposals={activeProposals}
                    isLoadingProposals={isLoadingProposals}
                />
            )}
        </PageCard>
    );
}
