"use client";

import {
    ArrowDown02Icon,
    ArrowExpandDiagonal01Icon,
    Cancel01Icon,
    CheckIcon,
    Delete01Icon,
    File01Icon,
    LinkSquare02Icon,
    LoaderCircleIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { Button } from "@/components/button";
import { ConfidentialState } from "@/components/confidential-state";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import { InfoAlert } from "@/components/info-alert";
import {
    SideSheet,
    SideSheetBody,
    SideSheetClose,
    SideSheetContent,
    SideSheetFooter,
    SideSheetHeader,
} from "@/components/side-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { SlotWarning } from "@/components/warning-message";
import { useTreasury } from "@/hooks/use-treasury";
import { useProposalApproveBlock } from "@/hooks/use-warnings";
import { getApproversAndThreshold } from "@/lib/config-utils";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import { useProposalDetails } from "../../hooks/use-proposal-details";
import { useProposalInsufficientBalance } from "../../hooks/use-proposal-insufficient-balance";
import { useVoteActionSlots } from "../../hooks/use-vote-action-slots";
import { useVotingDurationCheck } from "../../hooks/use-voting-duration-check";
import type {
    AnyProposalData,
    ConfidentialBulkData,
    ConfidentialRequestData,
    PaymentRequestData,
    ProposalUIKind,
} from "../../types/index";
import { extractProposalData } from "../../utils/proposal-extractors";
import { ExpandedViewInternal } from "../expanded-view";
import { RequestDisplayProvider } from "../expanded-view/common/request-display-context";
import { NotEnoughBalance } from "../not-enough-balance";
import { VotingDurationImpactModal } from "../voting-duration-impact-modal";
import { ApprovalWorkflow } from "./approval-workflow";
import { BulkDetails } from "./bulk-details";
import { DetailsCard } from "./primitives";
import { SendDetails } from "./send-details";

/** 28px ghost squares, the tray of actions the design gives the title bar. */
const HEADER_ACTION_CLASS =
    "size-7 rounded-sm p-1 text-general-secondary-foreground [&_svg]:size-[13.25px]";
/** The design's neutral footer button — 40px tall, grey, 12px radius. */
const FOOTER_BUTTON_CLASS =
    "h-10 w-full text-sm bg-general-bg-secondary text-general-secondary-foreground hover:bg-general-bg-secondary/80";
/**
 * Footer controls split the row evenly. The stretch lives on the container
 * because `AuthButtonWithProposal` wraps its button in a span of its own.
 */
const FOOTER_CLASS = "[&>*]:min-w-0 [&>*]:flex-1";

interface RequestDetailsSheetProps {
    /** The request to describe; `null` closes the sheet. */
    proposal: Proposal | null;
    policy: Policy;
    onOpenChange: (open: boolean) => void;
    onVote: (proposal: Proposal, vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

export function RequestDetailsSheet({
    proposal,
    policy,
    onOpenChange,
    onVote,
    onDeposit,
}: RequestDetailsSheetProps) {
    return (
        <SideSheet open={!!proposal} onOpenChange={onOpenChange}>
            <SideSheetContent>
                {/* Remounting per request keeps every derived query keyed to
                    the one on screen instead of leaking the previous one. */}
                {proposal && (
                    <RequestDetails
                        key={proposal.id}
                        proposal={proposal}
                        policy={policy}
                        onVote={(vote) => onVote(proposal, vote)}
                        onDeposit={onDeposit}
                    />
                )}
            </SideSheetContent>
        </SideSheet>
    );
}

function RequestDetails({
    proposal,
    policy,
    onVote,
    onDeposit,
}: {
    proposal: Proposal;
    policy: Policy;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}) {
    const t = useTranslations("proposals.expanded");
    const tCommon = useTranslations("common");
    const { treasuryId, isConfidential } = useTreasury();
    const { accountId } = useNear();
    const details = useProposalDetails(proposal, policy);
    const { status, isPending, isExecuted } = details;

    const { type, data } = extractProposalData(proposal, treasuryId);
    const send = resolveSendPayload(type, data);
    const isOwnPendingProposal = proposal.proposer === accountId && isPending;
    const hasVoted = !!proposal.votes[accountId ?? ""];
    const requestUrl = `/${treasuryId}/requests/${proposal.id}`;

    return (
        <>
            <SideSheetHeader
                title={t("details")}
                actions={
                    <>
                        {isOwnPendingProposal && !hasVoted && (
                            <Button
                                variant="ghost"
                                className={HEADER_ACTION_CLASS}
                                tooltipContent={t("deleteRequest")}
                                onClick={() => onVote("Remove")}
                            >
                                <Icon icon={Delete01Icon} />
                            </Button>
                        )}
                        <CopyButton
                            variant="ghost"
                            className={HEADER_ACTION_CLASS}
                            text={`${window.location.origin}${requestUrl}`}
                            tooltipContent={t("copyLink")}
                        />
                        <Button
                            asChild
                            variant="ghost"
                            className={HEADER_ACTION_CLASS}
                            tooltipContent={t("openRequestPage")}
                        >
                            <Link href={requestUrl}>
                                <Icon icon={ArrowExpandDiagonal01Icon} />
                            </Link>
                        </Button>
                        <SideSheetClose asChild>
                            <Button
                                variant="ghost"
                                className={HEADER_ACTION_CLASS}
                                aria-label={tCommon("close")}
                            >
                                <Icon icon={Cancel01Icon} />
                            </Button>
                        </SideSheetClose>
                    </>
                }
            />

            <SideSheetBody>
                <RequestDisplayProvider
                    value={{
                        showUSDValue: isPending,
                        isConfidential,
                        proposalStatus: status,
                        isPending,
                        isExecuted,
                    }}
                >
                    {send.kind === "send" ? (
                        <SendDetails data={send.data} />
                    ) : send.kind === "bulk" ? (
                        <BulkDetails data={send.data} />
                    ) : send.kind === "confidential-hidden" ? (
                        <HiddenSendDetails />
                    ) : (
                        // Request types not yet renovated keep their existing
                        // rows, just inside the sheet's card.
                        <DetailsCard className="p-4">
                            <ExpandedViewInternal
                                proposal={proposal}
                                policy={policy}
                                treasuryId={treasuryId}
                            />
                        </DetailsCard>
                    )}
                </RequestDisplayProvider>

                <ApprovalWorkflow
                    proposal={proposal}
                    policy={policy}
                    details={details}
                />

                <RequestNotices proposal={proposal} details={details} />
            </SideSheetBody>

            <RequestActions
                proposal={proposal}
                policy={policy}
                details={details}
                onVote={onVote}
                onDeposit={onDeposit}
            />
        </>
    );
}

/**
 * What the Send layout can be handed. A plain payment carries its payload
 * directly; a confidential one carries it wrapped — as a single transfer or as
 * a bulk one split across recipients — and only once the quote has been
 * decrypted for a member. Until then there is nothing to draw but the veil.
 * Anything else falls through to the request's existing rows.
 */
type SendPayload =
    | { kind: "send"; data: PaymentRequestData }
    | { kind: "bulk"; data: ConfidentialBulkData }
    | { kind: "confidential-hidden" }
    | { kind: "other" };

function resolveSendPayload(
    type: ProposalUIKind,
    data: AnyProposalData,
): SendPayload {
    if (type === "Payment Request") {
        return { kind: "send", data: data as PaymentRequestData };
    }
    if (type !== "Confidential Request") return { kind: "other" };

    const { mapped } = data as ConfidentialRequestData;
    if (!mapped) return { kind: "confidential-hidden" };
    switch (mapped.type) {
        case "payment":
            return { kind: "send", data: mapped.data };
        case "bulk":
            return { kind: "bulk", data: mapped.data };
        default:
            return { kind: "other" };
    }
}

/**
 * A confidential payment nobody on this screen may read: the same two cards the
 * Send layout would occupy, greyed out behind the confidentiality notice.
 */
function HiddenSendDetails() {
    return (
        <ConfidentialState
            skeleton={
                <div className="flex flex-col gap-3">
                    <Skeleton className="h-[121px] w-full rounded-3xl" />
                    <Skeleton className="h-[186px] w-full rounded-2xl" />
                </div>
            }
        />
    );
}

/**
 * Everything the sheet has to say that isn't the request itself: a swap still
 * settling, a paused action, a balance that won't cover the payment.
 */
function RequestNotices({
    proposal,
    details,
}: {
    proposal: Proposal;
    details: ReturnType<typeof useProposalDetails>;
}) {
    const t = useTranslations("proposals.expanded");
    const { treasuryId } = useTreasury();
    const {
        isPending,
        isExecuted,
        hasDepositAddress,
        swapStatus,
        shortQuoteDeadline,
        isPaymentLikeProposal,
    } = details;
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );
    const { voteBannerSlot } = useVoteActionSlots();
    const approveBlock = useProposalApproveBlock([proposal]);
    const approveBlockedWarning = approveBlock.blockedWarnings[0] ?? null;

    const isSettling =
        swapStatus?.status === "KNOWN_DEPOSIT_TX" ||
        swapStatus?.status === "PENDING_DEPOSIT" ||
        swapStatus?.status === "INCOMPLETE_DEPOSIT" ||
        swapStatus?.status === "PROCESSING";
    const hasFailed =
        swapStatus?.status === "FAILED" || swapStatus?.status === "REFUNDED";

    return (
        <>
            {isExecuted && hasDepositAddress && isSettling && (
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
            {isExecuted && hasDepositAddress && hasFailed && (
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
            {isPending && (
                <NotEnoughBalance
                    insufficientBalanceInfo={insufficientBalanceInfo}
                />
            )}
            {isPending && voteBannerSlot && (
                <SlotWarning slot={voteBannerSlot} />
            )}
            {/* Approval paused by a feature warning — rejection still works. */}
            {isPending &&
                !voteBannerSlot &&
                approveBlock.anyBlocked &&
                approveBlockedWarning?.slot && (
                    <SlotWarning
                        slot={approveBlockedWarning.slot}
                        token={approveBlockedWarning.token ?? undefined}
                        network={approveBlockedWarning.network ?? undefined}
                    />
                )}
        </>
    );
}

/**
 * The pinned footer: vote on a request that's still open, or follow a finished
 * one to its receipt and transaction. Requests that ended any other way have
 * nothing left to act on, so they get no footer at all.
 */
function RequestActions({
    proposal,
    policy,
    details,
    onVote,
    onDeposit,
}: {
    proposal: Proposal;
    policy: Policy;
    details: ReturnType<typeof useProposalDetails>;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}) {
    const t = useTranslations("proposals.expanded");
    const tReceipt = useTranslations("receiptPage");
    const noVoteMessage = useNoVoteMessage();
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const {
        isPending,
        isExecuted,
        canShowReceipt,
        receiptHref,
        transactionUrl,
        hideTransactionLink,
    } = details;

    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );
    const { approve: approveSlot, reject: rejectSlot } = useVoteActionSlots();
    const approveBlocked = useProposalApproveBlock([proposal]).anyBlocked;
    const hasVoted = !!proposal.votes[accountId ?? ""];

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
        isChecking,
        modalProps: votingDurationModalProps,
    } = useVotingDurationCheck({
        proposal,
        isLastApprovingVote,
        onApprove: () => onVote("Approve"),
    });

    const needsDeposit =
        insufficientBalanceInfo.hasInsufficientBalance &&
        insufficientBalanceInfo.showDeposit !== false;

    if (isExecuted) {
        const showTransaction = !hideTransactionLink && !!transactionUrl;
        if (!canShowReceipt && !showTransaction) return null;
        return (
            <SideSheetFooter className={cn(FOOTER_CLASS, "gap-3")}>
                {canShowReceipt && (
                    <Button
                        asChild
                        variant="secondary"
                        className={FOOTER_BUTTON_CLASS}
                    >
                        <Link
                            href={receiptHref}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Icon icon={File01Icon} />
                            {tReceipt("pdfReceipt")}
                        </Link>
                    </Button>
                )}
                {showTransaction && (
                    <Button
                        asChild
                        variant="secondary"
                        className={FOOTER_BUTTON_CLASS}
                    >
                        <Link
                            href={transactionUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <Icon icon={LinkSquare02Icon} />
                            {t("viewTransaction")}
                        </Link>
                    </Button>
                )}
            </SideSheetFooter>
        );
    }

    if (!isPending) return null;

    return (
        <SideSheetFooter className={FOOTER_CLASS}>
            <AuthButtonWithProposal
                proposalKind={proposal.kind}
                variant="secondary"
                className={FOOTER_BUTTON_CLASS}
                onClick={() => onVote("Reject")}
                disabled={hasVoted || rejectSlot.blocked}
                tooltip={
                    rejectSlot.inlineTooltip ??
                    (hasVoted ? noVoteMessage : undefined)
                }
            >
                <Icon icon={Cancel01Icon} />
                {t("reject")}
            </AuthButtonWithProposal>
            {needsDeposit ? (
                <Button
                    variant="default"
                    className="h-10 w-full text-sm"
                    onClick={() =>
                        onDeposit(
                            insufficientBalanceInfo.tokenId ||
                                insufficientBalanceInfo.tokenSymbol,
                            insufficientBalanceInfo.tokenNetwork,
                        )
                    }
                >
                    <Icon icon={ArrowDown02Icon} />
                    {t("deposit")}
                </Button>
            ) : (
                <AuthButtonWithProposal
                    proposalKind={proposal.kind}
                    variant="default"
                    className="h-10 w-full text-sm"
                    onClick={handleApprove}
                    disabled={
                        hasVoted ||
                        isChecking ||
                        approveBlocked ||
                        approveSlot.blocked
                    }
                    tooltip={
                        approveSlot.inlineTooltip ??
                        (hasVoted ? noVoteMessage : undefined)
                    }
                >
                    <Icon
                        icon={isChecking ? LoaderCircleIcon : CheckIcon}
                        className={cn(isChecking && "animate-spin")}
                    />
                    {t("approve")}
                </AuthButtonWithProposal>
            )}
            {votingDurationModalProps && (
                <VotingDurationImpactModal
                    {...votingDurationModalProps}
                    currentPolicy={policy}
                />
            )}
        </SideSheetFooter>
    );
}
