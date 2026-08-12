"use client";

import { useProposalTransaction, useSwapStatus } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { isNearComPaymentRoute } from "@/lib/intents-network";
import type { Proposal } from "@/lib/proposals-api";
import { getTransactionExplorerLink } from "@/lib/blockchain-utils";
import { nanosToMs } from "@/lib/utils";
import type { Policy } from "@/types/policy";
import type {
    ConfidentialRequestData,
    PaymentRequestData,
    SwapRequestData,
} from "../types/index";
import { extractProposalData } from "../utils/proposal-extractors";
import {
    getEffectiveExpiryMs,
    getProposalStatus,
    getProposalStatusDateInfo,
    getProposalUIKind,
    isQuoteDeadlineBeforeVotingPeriod,
} from "../utils/proposal-utils";
import {
    extractReceiptProposalData,
    isReceiptEligibleProposalKind,
    resolveExecutionTimestamp,
} from "../utils/receipt-utils";

function parseOptionalDate(value?: string | null) {
    if (!value) return undefined;

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Everything a details view needs to *describe* a proposal: where it is in its
 * lifecycle, the dates on that lifecycle, and the links a finished proposal
 * earns (receipt, transaction). Voting is deliberately not here — that's the
 * caller's business.
 *
 * The dates are the fiddly part: an intents-routed proposal settles off-chain,
 * so its execution timestamp comes from the swap rather than the transaction,
 * and a confidential proposal carries its own timestamps in backend-enriched
 * metadata. Both are resolved here so every surface tells the same story.
 */
export function useProposalDetails(proposal: Proposal, policy: Policy) {
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();

    const status = getProposalStatus(proposal, policy);
    const proposalType = getProposalUIKind(proposal);
    const isPending = status === "Pending";
    const isExecuted = status === "Executed";

    const isExchangeProposal = proposalType === "Exchange";
    const isPaymentProposal = proposalType === "Payment Request";
    const isConfidentialRequestProposal =
        proposalType === "Confidential Request";
    const isBatchPaymentProposal = proposalType === "Batch Payment Request";
    const isReceiptEligibleKind = isReceiptEligibleProposalKind(proposalType);
    const receiptProposalData = extractReceiptProposalData(
        proposal,
        treasuryId,
    );

    // Extract intents details for exchange/payment/confidential requests.
    // Confidential metadata is backend-enriched and nested under mapped.data.
    let depositAddress: string | undefined;
    let isConfidentialPayment = false;
    let confidentialPaymentData: PaymentRequestData | undefined;
    let confidentialProposalCreatedAt: Date | undefined;
    let confidentialExecutedAt: Date | undefined;
    let publicProposalCreatedAt: Date | undefined;
    let publicExecutedAt: Date | undefined;
    if (
        isExchangeProposal ||
        isPaymentProposal ||
        isConfidentialRequestProposal
    ) {
        try {
            const { data } = extractProposalData(proposal, treasuryId);
            if (isConfidentialRequestProposal) {
                const confidentialData = data as ConfidentialRequestData;
                confidentialProposalCreatedAt = parseOptionalDate(
                    confidentialData.proposalCreatedAt,
                );
                confidentialExecutedAt = parseOptionalDate(
                    confidentialData.executedAt,
                );
                const mapped = confidentialData.mapped;
                isConfidentialPayment = mapped?.type === "payment";
                if (mapped?.type === "payment") {
                    confidentialPaymentData = mapped.data;
                }
                // Only single payments and swaps are routed through a deposit
                // address; a bulk request has one per recipient leg.
                depositAddress =
                    mapped && mapped.type !== "bulk"
                        ? mapped.data.depositAddress
                        : undefined;
            } else {
                depositAddress = (data as PaymentRequestData | SwapRequestData)
                    .depositAddress;
                publicProposalCreatedAt = parseOptionalDate(
                    proposal.public_metadata?.proposal_created_at,
                );
                publicExecutedAt =
                    parseOptionalDate(
                        proposal.public_metadata?.proposal_executed_at,
                    ) ?? publicProposalCreatedAt;
            }
        } catch {}
    }
    const isPaymentLikeProposal = isPaymentProposal || isConfidentialPayment;

    // Whether this proposal used the Intents protocol (has a deposit address)
    const hasDepositAddress = !!depositAddress;
    const shouldUseTransactionDate = isExecuted;
    const shouldUseSwapDate =
        isExecuted && hasDepositAddress && !isConfidentialRequestProposal;

    // Fetch transaction data for non-intents proposals, or for statuses
    // whose resolved date/link should come from the chain transaction.
    const {
        data: transaction,
        isLoading: isLoadingTransaction,
        isAwaitingTransaction,
    } = useProposalTransaction(
        treasuryId,
        proposal,
        policy,
        shouldUseTransactionDate && (!hasDepositAddress || !shouldUseSwapDate),
    );

    // Fetch swap status for executed intents proposals (exchange or payment).
    const shouldFetchSwapStatus = isExecuted && hasDepositAddress;
    const { data: swapStatus, isLoading: isLoadingSwapStatus } = useSwapStatus(
        depositAddress || null,
        undefined,
        shouldFetchSwapStatus,
        treasuryId,
    );
    // Any intents-routed proposal (including confidential requests) must have a
    // SUCCESS swap status before a receipt can be generated — a pending/failed/
    // refunded swap has no finalized transaction to receipt.
    const shouldRequireSwapSuccess = hasDepositAddress;
    // Public treasury receipts should remain accessible for logged-out users
    // and non-members from the requests page.
    const isPublicTreasuryGuestViewer = !isConfidential && isGuestTreasury;
    const isSwapSuccessReady = shouldRequireSwapSuccess
        ? isPublicTreasuryGuestViewer || swapStatus?.status === "SUCCESS"
        : true;
    const { executedDate, isDateLoading: resolvedDateLoading } =
        resolveExecutionTimestamp({
            swapStatus,
            transaction,
            shouldUseSwapDate,
            isLoadingSwapStatus,
            isLoadingTransaction,
            isAwaitingTransaction,
            fallbackDate: confidentialExecutedAt ?? publicExecutedAt,
        });
    const isDateLoading = isExecuted && resolvedDateLoading;
    const isHidden = isConfidential && isGuestTreasury;

    // Swap is still settling (no finalized transaction yet).
    const isSwapProcessing = swapStatus?.status === "PROCESSING";
    // Hide the transaction link for confidential requests while the swap is
    // still processing — there is no finalized transaction to link to yet.
    const hideTransactionLink =
        isConfidentialRequestProposal && isSwapProcessing;
    // near.com confidential payments link to NEAR Blocks; all other
    // intents-routed proposals use the NEAR Intents explorer (masked for
    // confidential).
    const isConfidentialNearComPayment =
        isConfidentialPayment &&
        isNearComPaymentRoute(confidentialPaymentData ?? {});
    const useNearblocksLink =
        !hasDepositAddress || isConfidentialNearComPayment;
    // Receipt button visibility rules:
    // - Proposal must be executed and of a receipt-eligible kind.
    // - For intents-routed proposals (with depositAddress), swap status must be SUCCESS.
    // - Public batch receipts are hidden on confidential treasuries; confidential
    //   bulk uses Confidential Request kind and is allowed.
    // - Hidden (guest) confidential treasuries cannot generate receipts.
    const canShowReceipt =
        isExecuted &&
        !isHidden &&
        isReceiptEligibleKind &&
        isSwapSuccessReady &&
        (isBatchPaymentProposal
            ? !isConfidential
            : isConfidentialRequestProposal || receiptProposalData !== null);

    const expiresAt = new Date(getEffectiveExpiryMs(proposal, policy));
    const statusDateInfo = getProposalStatusDateInfo(proposal, policy);
    const shortQuoteDeadline = isQuoteDeadlineBeforeVotingPeriod(
        proposal,
        policy,
    );

    // Pending and expired proposals are dated by their deadline; everything
    // else by the moment it actually resolved.
    const timestamp =
        status === "Pending" || status === "Expired"
            ? statusDateInfo.date
            : (executedDate ?? undefined);

    const createdAt =
        confidentialProposalCreatedAt ??
        publicProposalCreatedAt ??
        new Date(nanosToMs(proposal.submission_time));

    const transactionUrl =
        getTransactionExplorerLink({
            depositAddress: useNearblocksLink ? null : depositAddress,
            isConfidential: isConfidentialRequestProposal,
            transactionHash: transaction?.transaction_hash,
        })?.url ?? null;

    return {
        status,
        proposalType,
        isPending,
        isExecuted,
        /** When the proposal was raised. */
        createdAt,
        /** When the proposal resolved, or when it will expire while pending. */
        timestamp,
        expiresAt,
        isDateLoading,
        shortQuoteDeadline,
        depositAddress,
        hasDepositAddress,
        swapStatus,
        transaction,
        /** Explorer link for the settled transaction, once there is one. */
        transactionUrl,
        hideTransactionLink,
        canShowReceipt,
        receiptHref: `/${treasuryId}/requests/${proposal.id}/receipt`,
        isPaymentLikeProposal,
    };
}
