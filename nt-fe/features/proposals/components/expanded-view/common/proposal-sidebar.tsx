import { Icon } from "@/components/icon";
import {
    ArrowDown02Icon,
    Cancel01Icon,
    File01Icon,
    LinkSquare02Icon,
    LoaderCircleIcon,
    CheckIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { useFormatDate } from "@/components/formatted-date";
import { InfoAlert } from "@/components/info-alert";
import { StepIcon } from "@/components/step-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { User } from "@/components/user";
import { SlotWarning } from "@/components/warning-message";
import { useProposalDetails } from "@/features/proposals/hooks/use-proposal-details";
import { useVotingDurationCheck } from "@/features/proposals/hooks/use-voting-duration-check";
import { useProposalInsufficientBalance } from "@/features/proposals/hooks/use-proposal-insufficient-balance";
import {
    getProposalStatus,
    type UIProposalStatus,
} from "@/features/proposals/utils/proposal-utils";
import { useTreasury } from "@/hooks/use-treasury";
import { useProposalApproveBlock } from "@/hooks/use-warnings";
import { getApproversAndThreshold } from "@/lib/config-utils";
import type { Proposal } from "@/lib/proposals-api";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import { NotEnoughBalance } from "../../not-enough-balance";
import { useVoteActionSlots } from "@/features/proposals/hooks/use-vote-action-slots";
import { UserVote } from "../../user-vote";
import { VotingDurationImpactModal } from "../../voting-duration-impact-modal";

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
                <User accountId={proposer} withHoverCard withLink={false} />
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
    const tCommon = useTranslations("common");
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
    const displayDateText = (() => {
        if (date) return formatDate(date);
        if (status === "Pending" || status === "Expired") {
            return formatDate(expiresAt);
        }
        return tCommon("notAvailable");
    })();

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
                            displayDateText
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
    const { treasuryId } = useTreasury();
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );

    const {
        status,
        isPending,
        isExecuted,
        createdAt,
        timestamp,
        expiresAt,
        isDateLoading,
        shortQuoteDeadline,
        hasDepositAddress,
        swapStatus,
        transactionUrl,
        hideTransactionLink,
        canShowReceipt,
        receiptHref,
        isPaymentLikeProposal,
    } = useProposalDetails(proposal, policy);

    const isUserVoter = !!proposal.votes[accountId ?? ""];

    // Approving payment/exchange proposals is blocked while that feature has a
    // critical warning. Rejection is never blocked.
    const approveBlock = useProposalApproveBlock([proposal]);
    const approveBlocked = approveBlock.anyBlocked;
    const approveBlockedWarning = approveBlock.blockedWarnings[0] ?? null;
    const {
        approve: approveSlot,
        reject: rejectSlot,
        voteBannerSlot,
    } = useVoteActionSlots();

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

    const {
        handleApprove,
        isChecking: isCheckingVotingDurationImpact,
        modalProps: votingDurationModalProps,
    } = useVotingDurationCheck({
        proposal,
        isLastApprovingVote,
        onApprove: () => onVote("Approve"),
    });

    return (
        <PageCard className="relative w-full">
            <div className="relative flex flex-col gap-4">
                <TransactionCreated
                    proposer={proposal.proposer}
                    date={createdAt}
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
                    isDateLoading={isDateLoading}
                />
                <div className="absolute left-[11px] top-1 bottom-2 w-px bg-muted-foreground/20" />
            </div>

            {/* Transaction Links */}
            {isExecuted && (
                <div className="flex flex-col gap-2">
                    {canShowReceipt && (
                        <Button asChild variant="secondary" className="w-full">
                            <Link
                                href={receiptHref}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Icon icon={File01Icon} />
                                {tReceipt("generateReceipt")}
                            </Link>
                        </Button>
                    )}
                    {!hideTransactionLink && transactionUrl && (
                        <Link
                            href={transactionUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex font-medium text-sm items-center justify-center gap-1.5 text-foreground"
                        >
                            <Icon icon={LinkSquare02Icon} />
                            {t("viewTransaction")}
                        </Link>
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

            {/* Short quote deadline warning (legacy 24h quotes) */}
            {isPending && shortQuoteDeadline && (
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

            {/* Vote action paused (approve / reject) — single banner */}
            {isPending && voteBannerSlot && (
                <SlotWarning slot={voteBannerSlot} />
            )}

            {/* Feature-maintenance warning — approval paused, rejection still works */}
            {isPending &&
                !voteBannerSlot &&
                approveBlocked &&
                approveBlockedWarning?.slot && (
                    <SlotWarning
                        slot={approveBlockedWarning.slot}
                        token={approveBlockedWarning.token ?? undefined}
                        network={approveBlockedWarning.network ?? undefined}
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
                        disabled={isUserVoter || rejectSlot.blocked}
                        tooltip={
                            rejectSlot.inlineTooltip
                                ? rejectSlot.inlineTooltip
                                : isUserVoter
                                  ? noVoteMessage
                                  : undefined
                        }
                    >
                        <Icon icon={Cancel01Icon} className="mr-2" />
                        {t("reject")}
                    </AuthButtonWithProposal>
                    {insufficientBalanceInfo.hasInsufficientBalance &&
                    insufficientBalanceInfo.showDeposit !== false ? (
                        <span className="w-full">
                            <Button
                                variant="default"
                                className="flex gap-1 w-full"
                                onClick={() =>
                                    onDeposit(
                                        insufficientBalanceInfo.tokenId ||
                                            insufficientBalanceInfo.tokenSymbol,
                                        insufficientBalanceInfo.tokenNetwork,
                                    )
                                }
                            >
                                <Icon icon={ArrowDown02Icon} className="mr-2" />
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
                                isUserVoter ||
                                isCheckingVotingDurationImpact ||
                                approveBlocked ||
                                approveSlot.blocked ||
                                insufficientBalanceInfo.hasInsufficientBalance
                            }
                            tooltip={
                                approveSlot.inlineTooltip
                                    ? approveSlot.inlineTooltip
                                    : isUserVoter
                                      ? noVoteMessage
                                      : undefined
                            }
                        >
                            {isCheckingVotingDurationImpact ? (
                                <Icon
                                    icon={LoaderCircleIcon}
                                    className="mr-2 animate-spin"
                                />
                            ) : (
                                <Icon icon={CheckIcon} className="mr-2" />
                            )}
                            {t("approve")}
                        </AuthButtonWithProposal>
                    )}
                </div>
            )}

            {votingDurationModalProps && (
                <VotingDurationImpactModal
                    {...votingDurationModalProps}
                    currentPolicy={policy}
                />
            )}
        </PageCard>
    );
}
