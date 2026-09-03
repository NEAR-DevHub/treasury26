export type DepositStep = "select" | "address";

export type DepositSource = "public_wallet" | "confidential_user";

/**
 * Legacy pay-share `source` query values. UI always uses near.com now; `trezu`
 * remains so old shared links still parse.
 */
export type ConfidentialOrigin = "trezu" | "nearcom";

/** Confidential reusable-address origin tabs (near business vs near.com). */
export type ConfidentialDepositOrigin = "near_business" | "nearcom";

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
