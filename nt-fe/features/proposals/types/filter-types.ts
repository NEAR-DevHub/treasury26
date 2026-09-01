// Shared type definitions for proposal filters

/**
 * The token shape the pickers hand over and the URL carries. Mirrors what
 * `useBridgeTokenOptions` produces: the icon is a URL, a data URI, or the
 * single letter it falls back to, and may be missing entirely.
 */
export interface TokenOption {
    id: string;
    name: string;
    icon?: string;
    gradient?: string;
}

// Base filter data structure
export interface BaseFilterData {
    operation: string;
}

export interface TokenFilterData extends BaseFilterData {
    token?: TokenOption;
    amountOperation?: string;
    minAmount?: string;
    maxAmount?: string;
}

export interface MyVoteFilterData extends BaseFilterData {
    selected: string[];
}

export interface ProposalTypeFilterData extends BaseFilterData {
    selected: string[];
}

export interface DateFilterData extends BaseFilterData {
    dateRange?: {
        from?: string;
        to?: string;
    };
}

export interface UserFilterData extends BaseFilterData {
    users: string[];
}

export type FilterData =
    | TokenFilterData
    | MyVoteFilterData
    | ProposalTypeFilterData
    | DateFilterData
    | UserFilterData;

// Helper to parse filter data (no fallback for backward compatibility)
export function parseFilterData<T extends FilterData>(
    value: string | null,
): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        // No fallback - enforce new JSON format
        return null;
    }
}

/**
 * A filter is "pending" from the moment it is added until a value is picked:
 * the pill renders as a bare label, it doesn't count towards the "Filters (N)"
 * total, and it doesn't narrow any results. This tells the two apart.
 */
export function hasFilterValue(value: string | null): boolean {
    const parsed = parseFilterData(value);
    if (!parsed) return false;
    if ("token" in parsed) return Boolean(parsed.token);
    if ("selected" in parsed) return parsed.selected.length > 0;
    if ("users" in parsed) return parsed.users.length > 0;
    if ("dateRange" in parsed)
        return Boolean(parsed.dateRange?.from || parsed.dateRange?.to);
    return false;
}
