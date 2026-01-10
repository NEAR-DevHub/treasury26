// Shared type definitions for proposal filters

export interface TokenOption {
    id: string;
    name: string;
    symbol: string;
    icon: string;
}

// Base filter data structure
export interface BaseFilterData {
    operation: string;
}

export interface TokenFilterData extends BaseFilterData {
    token: TokenOption;
    amountOperation?: string;
    minAmount?: string;
    maxAmount?: string;
}

export interface MyVoteFilterData extends BaseFilterData {
    votes: string[];
}

export interface ProposalTypeFilterData extends BaseFilterData {
    type: string;
}

export interface DateFilterData extends BaseFilterData {
    date: string;
}

export interface TextFilterData extends BaseFilterData {
    text: string;
}

export type FilterData =
    | TokenFilterData
    | MyVoteFilterData
    | ProposalTypeFilterData
    | DateFilterData
    | TextFilterData;

// Helper to parse filter data (no fallback for backward compatibility)
export function parseFilterData<T extends FilterData>(value: string): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        // No fallback - enforce new JSON format
        return null;
    }
}
