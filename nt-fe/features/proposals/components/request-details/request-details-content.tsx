"use client";

import {
    ArrowDown02Icon,
    Cancel01Icon,
    CheckIcon,
    File01Icon,
    LinkSquare02Icon,
    LoaderCircleIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { Button } from "@/components/button";
import { ConfidentialState } from "@/components/confidential-state";
import { Icon } from "@/components/icon";
import { InfoAlert } from "@/components/info-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { SlotWarning } from "@/components/warning-message";
import { useTreasury } from "@/hooks/use-treasury";
import { useProposalApproveBlock } from "@/hooks/use-warnings";
import { getApproversAndThreshold } from "@/lib/config-utils";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import type { useProposalDetails } from "../../hooks/use-proposal-details";
import { useProposalInsufficientBalance } from "../../hooks/use-proposal-insufficient-balance";
import { useProposalKindLabel } from "../../hooks/use-proposal-kind-label";
import { useVoteActionSlots } from "../../hooks/use-vote-action-slots";
import { useVotingDurationCheck } from "../../hooks/use-voting-duration-check";
import type {
    AnyProposalData,
    ConfidentialBulkData,
    ConfidentialRequestData,
    PaymentRequestData,
    ProposalUIKind,
    SwapRequestData,
} from "../../types/index";
import { extractProposalData } from "../../utils/proposal-extractors";
import { ExpandedViewInternal } from "../expanded-view";
import { RequestDisplayProvider } from "../expanded-view/common/request-display-context";
import { NotEnoughBalance } from "../not-enough-balance";
import { VotingDurationImpactModal } from "../voting-duration-impact-modal";
import { BulkDetails } from "./bulk-details";
import { DetailsCard } from "./primitives";
import { SendDetails } from "./send-details";
import { SwapDetails } from "./swap-details";

/** The design's neutral action button — 40px tall, grey, 12px radius. */
export const REQUEST_ACTION_BUTTON_CLASS =
    "h-10 w-full text-sm bg-general-bg-secondary text-general-secondary-foreground hover:bg-general-bg-secondary/80";
/**
 * Action controls split their row evenly. The stretch lives on the container
 * because `AuthButtonWithProposal` wraps its button in a span of its own.
 */
export const REQUEST_ACTION_ROW_CLASS = "[&>*]:min-w-0 [&>*]:flex-1";

/**
 * What the request *is*, drawn the way the renovated views draw it. Shared by
 * the details sheet and the full-screen request page so both tell one story.
 */
export function RequestDetailsBody({
    proposal,
    details,
}: {
    proposal: Proposal;
    details: ReturnType<typeof useProposalDetails>;
}) {
    const { treasuryId, isConfidential } = useTreasury();
    const { status, isPending, isExecuted } = details;
    const { type, data } = extractProposalData(proposal, treasuryId);
    const body = resolveBodyPayload(type, data);

    return (
        <RequestDisplayProvider
            value={{
                showUSDValue: isPending,
                isConfidential,
                proposalStatus: status,
                isPending,
                isExecuted,
            }}
        >
            {body.kind === "send" ? (
                <SendDetails data={body.data} />
            ) : body.kind === "swap" ? (
                <SwapDetails data={body.data} />
            ) : body.kind === "bulk" ? (
                <BulkDetails data={body.data} />
            ) : body.kind === "confidential-hidden" ? (
                <HiddenSendDetails />
            ) : (
                // Request types not yet renovated keep their existing rows,
                // just inside the shared card.
                <DetailsCard className="p-4">
                    <ExpandedViewInternal
                        proposal={proposal}
                        treasuryId={treasuryId}
                    />
                </DetailsCard>
            )}
        </RequestDisplayProvider>
    );
}

/**
 * Which renovated layout the body gets. A plain payment or exchange carries its
 * payload directly; a confidential one carries it wrapped — as a single
 * transfer, an exchange, or a bulk payment split across recipients — and only
 * once the quote has been decrypted for a member. Until then there is nothing
 * to draw but the veil. Anything else falls through to the request's existing
 * rows.
 */
type BodyPayload =
    | { kind: "send"; data: PaymentRequestData }
    | { kind: "swap"; data: SwapRequestData }
    | { kind: "bulk"; data: ConfidentialBulkData }
    | { kind: "confidential-hidden" }
    | { kind: "other" };

function resolveBodyPayload(
    type: ProposalUIKind,
    data: AnyProposalData,
): BodyPayload {
    if (type === "Payment Request") {
        return { kind: "send", data: data as PaymentRequestData };
    }
    if (type === "Exchange") {
        return { kind: "swap", data: data as SwapRequestData };
    }
    if (type !== "Confidential Request") return { kind: "other" };

    const { mapped } = data as ConfidentialRequestData;
    if (!mapped) return { kind: "confidential-hidden" };
    switch (mapped.type) {
        case "payment":
            return { kind: "send", data: mapped.data };
        case "swap":
            return { kind: "swap", data: mapped.data };
        case "bulk":
            return { kind: "bulk", data: mapped.data };
        default:
            return { kind: "other" };
    }
}

/**
 * What the details screen calls itself. A request drawn by one of the
 * renovated layouts is named after that layout — a payment is a send, an
 * exchange is a swap, a split payment is a bulk send — however it was filed,
 * so a confidential transfer reads as "Send details" rather than by the
 * wrapper it arrived in. Anything else, including a confidential request still
 * under its veil, keeps its kind.
 */
export function useRequestDetailsTitle(proposal: Proposal): string {
    const t = useTranslations("pages.requests");
    const getProposalKindLabel = useProposalKindLabel();
    const { treasuryId } = useTreasury();
    const { type, data } = extractProposalData(proposal, treasuryId);
    const body = resolveBodyPayload(type, data);

    switch (body.kind) {
        case "send":
            return t("sendDetailTitle");
        case "swap":
            return t("swapDetailTitle");
        case "bulk":
            return t("bulkDetailTitle");
        default:
            return t("detailTitle", { kind: getProposalKindLabel(type) });
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
 * Everything a request has to say that isn't the request itself: a swap still
 * settling, a paused action, a balance that won't cover the payment.
 */
export function RequestNotices({
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
 * The controls a request still offers: vote on one that's open, or follow a
 * finished one to its receipt and transaction. Requests that ended any other
 * way have nothing left to act on, so this is `null` for them and the caller
 * drops its container entirely.
 *
 * Returned rather than rendered because the sheet pins them to its footer while
 * the request page seats them inside the approval card.
 */
export function useRequestActions({
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
}): ReactNode | null {
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
            <>
                {canShowReceipt && (
                    <Button
                        asChild
                        variant="secondary"
                        className={REQUEST_ACTION_BUTTON_CLASS}
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
                        className={REQUEST_ACTION_BUTTON_CLASS}
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
            </>
        );
    }

    if (!isPending) return null;

    return (
        <>
            <AuthButtonWithProposal
                proposalKind={proposal.kind}
                variant="secondary"
                className={REQUEST_ACTION_BUTTON_CLASS}
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
        </>
    );
}
