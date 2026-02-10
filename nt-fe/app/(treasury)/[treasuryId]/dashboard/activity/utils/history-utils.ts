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

