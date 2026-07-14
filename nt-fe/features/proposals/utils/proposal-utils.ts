import { getKindFromProposal } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import {
    BatchPaymentRequestData,
    ConfidentialRequestData,
    PaymentRequestData,
    ProposalUIKind,
    StakingData,
    SwapRequestData,
    VestingData,
} from "../types/index";
import { decodeArgs, decodeProposalDescription, nanosToMs } from "@/lib/utils";
import { extractProposalData } from "./proposal-extractors";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

// Exchange custom deadline (capped by proposal_period).
// Pure wrap/unwrap (single wrap.near near_deposit/near_withdraw) uses normal proposal period.
export const EXCHANGE_EXPIRY_HOURS = 24;
export const EXCHANGE_EXPIRY_MS = EXCHANGE_EXPIRY_HOURS * 60 * 60 * 1000; // 24 hours in milliseconds

const BULK_PAYMENT_CONTRACT_ID =
    process.env.NEXT_PUBLIC_BULK_PAYMENT_CONTRACT_ID || "bulkpayment.near";

function isVestingProposal(proposal: Proposal): boolean {
    if (!("FunctionCall" in proposal.kind)) return false;
    const functionCall = proposal.kind.FunctionCall;
    const receiver = functionCall.receiver_id;
    const isLockup =
        receiver.includes("lockup.near") || receiver === "lockup.near";
    const firstAction = functionCall.actions[0];
    return isLockup && firstAction?.method_name === "create";
}

function isBatchPaymentProposal(proposal: Proposal): boolean {
    if (!("FunctionCall" in proposal.kind)) return false;
    const functionCall = proposal.kind.FunctionCall;

    // Check if calling bulk payment contract directly (NEAR payments)
    if (functionCall.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
        if (
            functionCall.actions.some(
                (action) => action.method_name === "approve_list",
            )
        ) {
            return true;
        }
    }

    // Check if calling intents contract
    if (
        functionCall.actions.some(
            (action) => action.method_name === "mt_transfer_call",
        )
    ) {
        const mtTransferAction = functionCall.actions.find(
            (action) => action.method_name === "mt_transfer_call",
        );
        if (mtTransferAction) {
            const args = decodeArgs(mtTransferAction.args);
            if (args?.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
                return true;
            }
        }
    }

    // Check if calling ft contract
    if (
        functionCall.actions.some(
            (action) => action.method_name === "ft_transfer_call",
        )
    ) {
        const ftTransferAction = functionCall.actions.find(
            (action) => action.method_name === "ft_transfer_call",
        );
        if (ftTransferAction) {
            const args = decodeArgs(ftTransferAction.args);
            if (args?.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
                return true;
            }
        }
    }

    return false;
}

function processFTTransferProposal(
    proposal: Proposal,
): "Payment Request" | "Batch Payment Request" | "Exchange" | undefined {
    if (!("FunctionCall" in proposal.kind)) return undefined;
    const functionCall = proposal.kind.FunctionCall;
    if (
        isIntentWithdrawProposal(proposal) ||
        isLookupTransferProposal(proposal)
    ) {
        return "Payment Request" as const;
    }
    const proposalAction = decodeProposalDescription(
        "proposal action",
        proposal.description,
    );
    if (proposalAction === "asset-exchange") {
        return "Exchange" as const;
    }
    // Payment proposals routed through Intents (native NEAR wrap+transfer or
    // NEAR FT transfer to deposit address) must be classified before the
    // generic near_deposit check below, which would otherwise catch them.
    if (proposalAction === "payment-transfer") {
        return "Payment Request" as const;
    }

    if (
        functionCall.receiver_id === WRAP_NEAR_TOKEN_ID &&
        functionCall.actions.some(
            (action) =>
                action.method_name === "near_withdraw" ||
                action.method_name === "near_deposit",
        )
    ) {
        return "Exchange" as const;
    }

    const action = functionCall.actions.find(
        (action) =>
            action.method_name === "ft_transfer" ||
            action.method_name === "ft_transfer_call",
    );
    if (!action) return undefined;
    if (action.method_name === "ft_transfer") {
        return "Payment Request" as const;
    }
    const args = decodeArgs(action.args);
    if (!args) return undefined;
    if (args.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
        return "Batch Payment Request" as const;
    }
    return "Payment Request" as const;
}

function processMTTransferProposal(
    proposal: Proposal,
): "Exchange" | "Batch Payment Request" | "Payment Request" | undefined {
    if (!("FunctionCall" in proposal.kind)) return undefined;
    const functionCall = proposal.kind.FunctionCall;
    const proposalAction = decodeProposalDescription(
        "proposal action",
        proposal.description,
    );
    // NEP-245 withdrawal via mt_withdraw is always a Payment Request
    if (
        functionCall.actions.some(
            (action) => action.method_name === "mt_withdraw",
        )
    ) {
        return "Payment Request" as const;
    }

    const transfer = functionCall.actions.find(
        (action) =>
            action.method_name === "mt_transfer" ||
            action.method_name === "mt_transfer_call",
    );
    if (transfer) {
        const args = decodeArgs(transfer?.args as string);
        if (args?.receiver_id === BULK_PAYMENT_CONTRACT_ID) {
            return "Batch Payment Request" as const;
        }
        if (proposalAction === "payment-transfer") {
            return "Payment Request" as const;
        }
        return "Exchange" as const;
    }
    return undefined;
}

function isIntentWithdrawProposal(proposal: Proposal): boolean {
    if (!("FunctionCall" in proposal.kind)) return false;
    const functionCall = proposal.kind.FunctionCall;
    if (functionCall.receiver_id !== "intents.near") return false;

    // NEP-141 withdrawal via ft_withdraw
    if (
        functionCall.actions.some(
            (action) => action.method_name === "ft_withdraw",
        )
    ) {
        return true;
    }

    // NEP-245 withdrawal via mt_withdraw
    if (
        functionCall.actions.some(
            (action) => action.method_name === "mt_withdraw",
        )
    ) {
        return true;
    }

    return false;
}

function isLookupTransferProposal(proposal: Proposal): boolean {
    if (!("FunctionCall" in proposal.kind)) return false;
    const functionCall = proposal.kind.FunctionCall;
    return (
        functionCall.receiver_id.endsWith(".lockup.near") &&
        functionCall.actions.some((action) => action.method_name === "transfer")
    );
}

function stakingType(
    proposal: Proposal,
): "Earn NEAR" | "Withdraw Earnings" | "Unstake NEAR" | undefined {
    if (!("FunctionCall" in proposal.kind)) return undefined;
    const functionCall = proposal.kind.FunctionCall;

    const isPool =
        functionCall.receiver_id.endsWith("poolv1.near") ||
        functionCall.receiver_id.endsWith("lockup.near");
    if (!isPool) return undefined;

    const mapping = {
        "Earn NEAR": ["stake", "deposit_and_stake", "deposit"],
        "Withdraw Earnings": [
            "withdraw",
            "withdraw_all",
            "withdraw_all_from_staking_pool",
        ],
        "Unstake NEAR": ["unstake", "unstake_all"],
    } as const;

    for (const [label, methods] of Object.entries(mapping) as [
        "Earn NEAR" | "Withdraw Earnings" | "Unstake NEAR",
        readonly string[],
    ][]) {
        if (
            functionCall.actions.some((action) =>
                methods.includes(action.method_name),
            )
        ) {
            return label;
        }
    }
    return undefined;
}

/**
 * Determines the UI kind/category for a proposal
 * This classifies proposals into user-facing categories for display
 * @param proposal The proposal to classify
 * @returns The UI kind of the proposal
 */
export function getProposalUIKind(proposal: Proposal): ProposalUIKind {
    const proposalType = getKindFromProposal(proposal.kind);
    switch (proposalType) {
        case "transfer":
            return "Payment Request";
        case "call": {
            const proposalAction = decodeProposalDescription(
                "proposal action",
                proposal.description,
            );
            if (proposalAction === "confidential") {
                return "Confidential Request";
            }
            if (isVestingProposal(proposal)) {
                return "Vesting";
            }
            const ftTransferResult = processFTTransferProposal(proposal);
            if (ftTransferResult) {
                return ftTransferResult;
            }
            if (isBatchPaymentProposal(proposal)) {
                return "Batch Payment Request";
            }
            const mtTransferResult = processMTTransferProposal(proposal);
            if (mtTransferResult) {
                return mtTransferResult;
            }
            const stakingTypeResult = stakingType(proposal);
            if (stakingTypeResult) {
                return stakingTypeResult;
            }
            return "Function Call";
        }
        case "policy":
            return "Change Policy";
        case "config":
            return "Update General Settings";
        case "upgrade_self":
        case "upgrade_remote":
            return "Upgrade";
        case "add_member_to_role":
        case "remove_member_from_role":
            return "Members";
        case "set_staking_contract":
            return "Set Staking Contract";
        case "add_bounty":
        case "bounty_done":
            return "Bounty";
        case "vote":
            return "Vote";
        case "factory_info_update":
            return "Factory Info Update";
        default:
            return "Unsupported";
    }
}

export type UIProposalStatus =
    | "Executed"
    | "Rejected"
    | "Pending"
    | "Failed"
    | "Expired"
    | "Removed"
    | "Moved";

function isNormalPeriodWrapProposal(proposal: Proposal): boolean {
    if (!("FunctionCall" in proposal.kind)) return false;

    const functionCall = proposal.kind.FunctionCall;
    const actions = functionCall.actions ?? [];

    if (
        functionCall.receiver_id !== WRAP_NEAR_TOKEN_ID ||
        actions.length !== 1
    ) {
        return false;
    }

    const methodName = actions[0]?.method_name;
    return methodName === "near_deposit" || methodName === "near_withdraw";
}

export function isShortExpiryExchangeProposal(proposal: Proposal): boolean {
    const isExchangeProposal = getProposalUIKind(proposal) === "Exchange";
    return isExchangeProposal && !isNormalPeriodWrapProposal(proposal);
}

function getEffectiveExpiryPeriodMs(
    proposal: Proposal,
    policy: Policy,
): number {
    const proposalPeriodMs = nanosToMs(policy.proposal_period);
    if (!isShortExpiryExchangeProposal(proposal)) return proposalPeriodMs;
    return Math.min(proposalPeriodMs, EXCHANGE_EXPIRY_MS);
}

export function getProposalStatus(
    proposal: Proposal,
    policy: Policy,
): UIProposalStatus {
    const submissionTimeMs = nanosToMs(proposal.submission_time);

    switch (proposal.status) {
        case "Approved":
            return "Executed";
        case "Rejected":
            return "Rejected";
        case "Failed":
            return "Failed";
        case "InProgress":
            if (
                submissionTimeMs +
                    getEffectiveExpiryPeriodMs(proposal, policy) <
                Date.now()
            ) {
                return "Expired";
            }

            return "Pending";
        default:
            return proposal.status;
    }
}

/**
 * Returns the status-relevant date for a proposal and metadata for display.
 * - Pending: expiration date (future)
 * - All others (Executed, Rejected, Failed, Expired, Removed, Moved): submission_time (past)
 *
 * Returns { date, isFuture, label } where label is the status verb prefix for non-pending.
 */
export type StatusDateLabelKey = "expires" | "created" | "expired" | "removed";

export function getProposalStatusDateInfo(
    proposal: Proposal,
    policy: Policy,
): { date: Date; isFuture: boolean; labelKey: StatusDateLabelKey | null } {
    const submissionTimeMs = nanosToMs(proposal.submission_time);
    const uiStatus = getProposalStatus(proposal, policy);

    if (uiStatus === "Pending") {
        const expiryDate = new Date(
            submissionTimeMs + getEffectiveExpiryPeriodMs(proposal, policy),
        );
        return { date: expiryDate, isFuture: true, labelKey: "expires" };
    }

    // For all resolved statuses, use submission_time as a fallback since
    // the API doesn't provide a separate execution timestamp.
    const submissionDate = new Date(submissionTimeMs);

    switch (uiStatus) {
        case "Executed":
            return {
                date: submissionDate,
                isFuture: false,
                labelKey: "created",
            };
        case "Rejected":
            return {
                date: submissionDate,
                isFuture: false,
                labelKey: "created",
            };
        case "Failed":
            return {
                date: submissionDate,
                isFuture: false,
                labelKey: "created",
            };
        case "Expired": {
            const expiredDate = new Date(
                submissionTimeMs + getEffectiveExpiryPeriodMs(proposal, policy),
            );
            return {
                date: expiredDate,
                isFuture: false,
                labelKey: "expired",
            };
        }
        case "Removed":
            return {
                date: submissionDate,
                isFuture: false,
                labelKey: "removed",
            };
        default:
            return { date: submissionDate, isFuture: false, labelKey: null };
    }
}

/**
 * Helper to extract token ID and amount required for a proposal
 */
export function getProposalRequiredFunds(
    proposal: Proposal,
    treasuryId?: string,
): { tokenId: string; amount: string } | null {
    if (typeof proposal.kind === "string") {
        return null;
    }

    const { type: uiKind, data } = extractProposalData(proposal, treasuryId);

    switch (uiKind) {
        case "Payment Request": {
            const d = data as PaymentRequestData;
            return { tokenId: d.tokenId, amount: d.amount };
        }
        case "Batch Payment Request": {
            const d = data as BatchPaymentRequestData;
            return { tokenId: d.tokenId, amount: d.totalAmount };
        }
        case "Exchange": {
            const d = data as SwapRequestData;
            return {
                tokenId: d.tokenInAddress ?? d.tokenIn,
                amount: d.amountIn,
            };
        }
        case "Earn NEAR":
        case "Unstake NEAR":
        case "Withdraw Earnings": {
            const d = data as StakingData;
            return { tokenId: d.tokenId, amount: d.amount };
        }
        case "Vesting": {
            const d = data as VestingData;
            return { tokenId: d.tokenId, amount: d.amount };
        }
        case "Confidential Request": {
            const d = data as ConfidentialRequestData;
            if (d.mapped?.type === "payment") {
                return {
                    tokenId: d.mapped.data.tokenId,
                    amount: d.mapped.data.amount,
                };
            }
            if (d.mapped?.type === "swap") {
                return {
                    tokenId:
                        d.mapped.data.tokenInAddress ?? d.mapped.data.tokenIn,
                    amount: d.mapped.data.amountIn,
                };
            }
            if (d.mapped?.type === "bulk") {
                return {
                    tokenId: d.mapped.data.tokenId,
                    amount: d.mapped.data.totalAmount,
                };
            }
            return null;
        }
        default:
            return null;
    }
}
