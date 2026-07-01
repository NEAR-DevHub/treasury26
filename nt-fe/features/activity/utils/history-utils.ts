"use client";

import { useTranslations } from "next-intl";

/**
 * Format history duration based on months
 * Converts to years if it's a whole year (12, 24, 36, etc.)
 *
 * @param historyMonths - Number of months of history allowed by the plan
 * @param includePrefix - Whether to include "last" prefix (default: true)
 * @returns Formatted duration string
 *
 * @example
 * formatHistoryDuration(3) => "last 3 months"
 * formatHistoryDuration(12) => "last 1 year"
 * formatHistoryDuration(24) => "last 2 years"
 * formatHistoryDuration(null) => "unlimited history"
 * formatHistoryDuration(12, false) => "1 year"
 */
export interface HistoryDurationLabels {
    unlimited: string;
    oneYear: string;
    years: (count: number) => string;
    months: (count: number) => string;
    lastPrefix: (duration: string) => string;
}

export function formatHistoryDuration(
    historyMonths: number | null | undefined,
    labels: HistoryDurationLabels,
    includePrefix: boolean = true,
): string {
    if (!historyMonths) return labels.unlimited;

    if (historyMonths % 12 === 0) {
        const years = historyMonths / 12;
        const duration = years === 1 ? labels.oneYear : labels.years(years);
        return includePrefix ? labels.lastPrefix(duration) : duration;
    }

    const duration = labels.months(historyMonths);
    return includePrefix ? labels.lastPrefix(duration) : duration;
}

/**
 * Get a full description for history including transaction type
 *
 * @param historyMonths - Number of months of history allowed by the plan
 * @returns Full description string
 *
 * @example
 * getHistoryDescription(3) => "Sent and received transactions (last 3 months)"
 * getHistoryDescription(12) => "Sent and received transactions (last 1 year)"
 * getHistoryDescription(null) => "View all your transaction history"
 */
export interface HistoryDescriptionLabels extends HistoryDurationLabels {
    viewAll: string;
    sentReceived: (duration: string) => string;
}

export function getHistoryDescription(
    historyMonths: number | null | undefined,
    labels: HistoryDescriptionLabels,
): string {
    if (!historyMonths) return labels.viewAll;

    const duration = formatHistoryDuration(historyMonths, labels, true);
    return labels.sentReceived(duration);
}

const PROPOSAL_METHODS = ["add_proposal", "act_proposal"];

/**
 * Activity type for helper functions
 */
export interface ActivityAccount {
    counterparty: string | null;
    signerId: string | null;
    receiverId: string | null;
    swap?: any; // Swap object if this is a swap transaction
    actionKind?: string | null;
    methodName?: string | null;
    amount?: string;
    tokenSymbol?: string;
}

/**
 * Get the display label for an activity based on its action kind.
 *
 * Priority order:
 * 1. Swaps → "Exchange"
 * 2. Staking rewards → "Staking Rewards"
 * 3. Proposal actions → "Proposal Action"
 * 4. Incoming → "Deposit [TOKEN]"
 * 5. Outgoing → "Payment Sent"
 * 6. No action data → "Transaction"
 */
export interface ActivityLabels {
    exchangePending: string;
    exchangeRequest: string;
    exchangeFulfillment: string;
    stakingRewards: string;
    proposalAction: string;
    deposit: (symbol: string) => string;
    paymentSent: string;
    transaction: string;
    fallbackToken: string;
}

export function getActivityLabel(
    activity: ActivityAccount,
    labels: ActivityLabels,
): string {
    if (activity.swap) {
        if (activity.swap.swapRole === "deposit") {
            return activity.swap.receivedAmount == null
                ? labels.exchangePending
                : labels.exchangeRequest;
        }
        return labels.exchangeFulfillment;
    }
    if (activity.actionKind === "StakingReward") return labels.stakingRewards;

    if (
        activity.actionKind === "FunctionCall" &&
        activity.methodName &&
        PROPOSAL_METHODS.includes(activity.methodName)
    ) {
        return labels.proposalAction;
    }

    const isReceived = parseFloat(activity.amount ?? "0") > 0;

    if (activity.actionKind) {
        if (isReceived) {
            const symbol = activity.tokenSymbol || labels.fallbackToken;
            return labels.deposit(symbol);
        }
        return labels.paymentSent;
    }

    return labels.transaction;
}

/**
 * Get the sub-label (description line) for an activity.
 *
 * - Swaps → "via NEAR Intents"
 * - Staking rewards → pool address
 * - Proposal actions → method name
 * - Incoming → "from {counterparty}" (only if known)
 * - Outgoing → "to {counterparty}" (only if known)
 * - No action data → empty
 */
export interface ActivitySubLabels {
    viaIntents: string;
    from: (account: string) => string;
    to: (account: string) => string;
}

export function getActivitySubLabel(
    activity: ActivityAccount,
    _treasuryId: string | null | undefined,
    labels: ActivitySubLabels,
): string {
    if (activity.swap) return labels.viaIntents;

    if (activity.actionKind === "StakingReward") return "";

    if (
        activity.actionKind === "FunctionCall" &&
        activity.methodName &&
        PROPOSAL_METHODS.includes(activity.methodName)
    ) {
        return "";
    }

    const isReceived = parseFloat(activity.amount ?? "0") > 0;

    if (isReceived) {
        const from = activity.counterparty || activity.signerId;
        return from && from !== "UNKNOWN" ? labels.from(from) : "";
    }

    const to = activity.counterparty || activity.receiverId;
    return to && to !== "UNKNOWN" ? labels.to(to) : "";
}

function normalizeAccountValue(
    value: string | null | undefined,
): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.toUpperCase() === "UNKNOWN") return null;
    return trimmed;
}

function resolveAccountDisplay(
    values: Array<string | null | undefined>,
    isConfidentialTreasury: boolean,
): string {
    for (const value of values) {
        const normalized = normalizeAccountValue(value);
        if (normalized) return normalized;
    }
    return isConfidentialTreasury ? "Confidential" : "N/A";
}

/**
 * Determines the sender of a transaction
 * For swaps: show "via NEAR Intents"
 * For received payments: show the counterparty who sent funds (if known)
 * For sent payments: sender is always the DAO
 */
export function getFromAccount(
    activity: ActivityAccount,
    isReceived: boolean,
    treasuryId: string | null | undefined,
    viaIntentsLabel: string,
    isConfidentialTreasury: boolean = false,
): string {
    if (activity.swap) return viaIntentsLabel;
    if (isReceived) {
        return resolveAccountDisplay(
            [activity.counterparty, activity.signerId],
            isConfidentialTreasury,
        );
    }
    return resolveAccountDisplay([treasuryId], isConfidentialTreasury);
}

/**
 * Determines the recipient of a transaction
 * For swaps: show treasury
 * For sent payments: receiver is the counterparty
 * For received payments: receiver is treasuryId
 */
export function getToAccount(
    activity: ActivityAccount,
    isReceived: boolean,
    treasuryId: string | null | undefined,
    isConfidentialTreasury: boolean = false,
): string {
    if (isReceived) {
        return resolveAccountDisplay([treasuryId], isConfidentialTreasury);
    }
    return resolveAccountDisplay(
        [activity.counterparty, activity.receiverId],
        isConfidentialTreasury,
    );
}

/**
 * Resolve the raw sender account id (no display fallbacks). Returns null when
 * there is no real account to link to (swaps, or missing/unknown values), so
 * callers can decide whether to render a hoverable user vs. a plain label.
 */
export function getFromAccountId(
    activity: ActivityAccount,
    isReceived: boolean,
    treasuryId: string | null | undefined,
): string | null {
    if (activity.swap) return null;
    if (isReceived) {
        return (
            normalizeAccountValue(activity.counterparty) ??
            normalizeAccountValue(activity.signerId)
        );
    }
    return normalizeAccountValue(treasuryId);
}

/**
 * Resolve the raw recipient account id (no display fallbacks). Returns null
 * when there is no real account to link to.
 */
export function getToAccountId(
    activity: ActivityAccount,
    isReceived: boolean,
    treasuryId: string | null | undefined,
): string | null {
    if (isReceived) {
        return normalizeAccountValue(treasuryId);
    }
    return (
        normalizeAccountValue(activity.counterparty) ??
        normalizeAccountValue(activity.receiverId)
    );
}

function buildHistoryDescriptionLabels(
    t: (key: string, values?: Record<string, any>) => string,
): HistoryDescriptionLabels {
    return {
        unlimited: t("unlimitedHistory"),
        oneYear: t("oneYear"),
        years: (count: number) => t("yearsCount", { count }),
        months: (count: number) => t("monthsCount", { count }),
        lastPrefix: (duration: string) => t("lastDuration", { duration }),
        viewAll: t("viewAll"),
        sentReceived: (duration: string) => t("sentReceived", { duration }),
    };
}

function buildActivityLabels(
    t: (key: string, values?: Record<string, any>) => string,
): ActivityLabels {
    return {
        exchangePending: t("exchangePending"),
        exchangeRequest: t("exchangeRequest"),
        exchangeFulfillment: t("exchangeFulfillment"),
        stakingRewards: t("stakingRewards"),
        proposalAction: t("proposalAction"),
        deposit: (symbol: string) => t("deposit", { symbol }),
        paymentSent: t("paymentSent"),
        transaction: t("transaction"),
        fallbackToken: t("fallbackToken"),
    };
}

function buildActivitySubLabels(
    t: (key: string, values?: Record<string, any>) => string,
): ActivitySubLabels {
    return {
        viaIntents: t("viaIntents"),
        from: (account: string) => t("from", { account }),
        to: (account: string) => t("to", { account }),
    };
}

export function useFormatHistoryDuration() {
    const t = useTranslations("activityLabels");
    const labels = buildHistoryDescriptionLabels(t);
    return (
        historyMonths: number | null | undefined,
        includePrefix: boolean = true,
    ) => formatHistoryDuration(historyMonths, labels, includePrefix);
}

export function useGetHistoryDescription() {
    const t = useTranslations("activityLabels");
    const labels = buildHistoryDescriptionLabels(t);
    return (historyMonths: number | null | undefined) =>
        getHistoryDescription(historyMonths, labels);
}

export function useGetActivityLabel() {
    const t = useTranslations("activityLabels");
    const labels = buildActivityLabels(t);
    return (activity: ActivityAccount) => getActivityLabel(activity, labels);
}

export function useGetActivitySubLabel() {
    const t = useTranslations("activityLabels");
    const labels = buildActivitySubLabels(t);
    return (activity: ActivityAccount, treasuryId: string | null | undefined) =>
        getActivitySubLabel(activity, treasuryId, labels);
}

export function useGetFromAccount() {
    const t = useTranslations("activityLabels");
    return (
        activity: ActivityAccount,
        isReceived: boolean,
        treasuryId: string | null | undefined,
        isConfidentialTreasury: boolean = false,
    ) =>
        getFromAccount(
            activity,
            isReceived,
            treasuryId,
            t("viaIntents"),
            isConfidentialTreasury,
        );
}
