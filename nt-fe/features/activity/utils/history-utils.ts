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
export function formatHistoryDuration(
    historyMonths: number | null | undefined,
    includePrefix: boolean = true
): string {
    if (!historyMonths) return "unlimited history";

    // Convert to years if it's a whole year (12, 24, 36, etc.)
    if (historyMonths % 12 === 0) {
        const years = historyMonths / 12;
        const duration = years === 1 ? "1 year" : `${years} years`;
        return includePrefix ? `last ${duration}` : duration;
    }

    // Otherwise show months
    const duration = `${historyMonths} months`;
    return includePrefix ? `last ${duration}` : duration;
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
export function getHistoryDescription(
    historyMonths: number | null | undefined
): string {
    if (!historyMonths) return "View all your transaction history";

    const duration = formatHistoryDuration(historyMonths, true);
    return `Sent and received transactions (${duration})`;
}

/**
 * Activity type for helper functions
 */
export interface ActivityAccount {
    counterparty: string | null;
    signerId: string | null;
    receiverId: string | null;
}

/**
 * Determines the sender of a transaction
 * For received payments: show counterparty (the sender)
 * For sent payments: show signerId (the account that initiated the transaction)
 * 
 * @param activity - The activity object containing counterparty and signerId
 * @param isReceived - Whether this is a received payment (amount > 0)
 * @returns The sender account ID or "—" if not available
 */
export function getFromAccount(activity: ActivityAccount, isReceived: boolean): string {
    if (isReceived && activity.counterparty) {
        return activity.counterparty;
    }
    return activity.signerId || "—";
}

/**
 * Determines the recipient of a transaction
 * For sent payments: show receiverId (primary), fallback to counterparty, then treasuryId
 * For received payments: show treasuryId (the treasury is always the recipient)
 * 
 * @param activity - The activity object containing receiverId and counterparty
 * @param isReceived - Whether this is a received payment (amount > 0)
 * @param treasuryId - The treasury account ID (recipient for received payments)
 * @returns The recipient account ID or "—" if not available
 */
export function getToAccount(
    activity: ActivityAccount,
    isReceived: boolean,
    treasuryId: string | null | undefined
): string {
    if (!isReceived) {
        return activity.receiverId || activity.counterparty || treasuryId || "—";
    }
    return treasuryId || "—";
}

