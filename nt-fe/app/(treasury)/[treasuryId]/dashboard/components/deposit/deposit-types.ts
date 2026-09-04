export type DepositStep = "select" | "address";

export type DepositSource = "public_wallet" | "confidential_user";

/**
 * Legacy pay-share `source` query values. Kept so old shared links still parse;
 * the confidential share page always offers both near business and near.com.
 */
export type ConfidentialOrigin = "trezu" | "nearcom";

export interface DepositInfo {
    address: string;
    memo: string | null;
    minDepositAmount: string | null;
    /** Epoch ms expiry from backend (`expiresAt`); null when not applicable. */
    expiresAtMs: number | null;
    /** Intents quote address for confidential status polling; null when N/A. */
    quoteDepositAddress: string | null;
}

export interface SelectOption {
    id: string;
    name: string;
    description?: string;
    symbol?: string;
    icon: string;
    gradient?: string;
    networks?: unknown[];
    chainId?: string;
}
