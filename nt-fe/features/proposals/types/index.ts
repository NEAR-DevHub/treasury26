import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";

/**
 * UI representation of proposal kinds
 * This is the user-facing categorization of proposals
 */
export type ProposalUIKind =
    | "Payment Request"
    | "Swap Request"
    | "Function Call"
    | "Change Policy"
    | "Change Config"
    | "Staking"
    | "Vesting"
    | "Withdraw"
    | "Unknown";

/**
 * @deprecated Use ProposalUIKind instead
 */
export type ProposalType = ProposalUIKind;

/**
 * Vesting schedule details
 */
export interface VestingSchedule {
    start_timestamp: string;
    end_timestamp: string;
    cliff_timestamp: string;
}

/**
 * Data structure for Payment Request proposals
 * Used for both direct transfers and FT transfers
 */
export interface PaymentRequestData {
    tokenId: string;
    amount: string;
    receiver: string;
    notes: string;
    network: string;
}

/**
 * Data structure for Function Call proposals
 */
export interface FunctionCallData {
    receiver: string;
    methodName: string;
    actionsCount: number;
    gas: string;
    deposit: string;
    args: Record<string, any>;
}

/**
 * Data structure for Change Policy proposals
 */
export interface ChangePolicyData {
    policy: Policy;
    rolesCount: number;
}

/**
 * Data structure for Change Config proposals
 */
export interface ChangeConfigData {
    name: string;
    purpose: string;
    metadata: Record<string, any>;
}

/**
 * Data structure for Staking proposals (and Withdraw)
 */
export interface StakingData {
    tokenId: string;
    amount: string;
    receiver: string;
    action: "stake" | "deposit" | "deposit_and_stake" | "withdraw" | "unstake";
    sourceWallet: "Lockup" | "Wallet";
    validatorUrl: string;
    isLockup: boolean;
    lockupPool: string;
    notes: string;
}

/**
 * Data structure for Vesting proposals
 */
export interface VestingData {
    tokenId: string;
    amount: string;
    receiver: string;
    vestingSchedule: VestingSchedule | null;
    whitelistAccountId: string;
    foundationAccountId: string;
    allowCancellation: boolean;
    allowStaking: boolean;
    notes: string;
}

export interface SwapRequestData {
    timeEstimate?: string;
    quoteSignature?: string;
    depositAddress: string;
    tokenIn: string;
    sourceNetwork: string;
    destinationNetwork: string;
    amountIn: string;
    tokenOut: string;
    amountOut: string;
    slippage?: string;
    quoteDeadline?: string;
}

/**
 * Data structure for Unknown proposals
 */
export interface UnknownData {
    message: string;
}

/**
 * Mapping of proposal types to their data structures
 */
export interface ProposalTypeDataMap {
    "Payment Request": PaymentRequestData;
    "Function Call": FunctionCallData;
    "Change Policy": ChangePolicyData;
    "Change Config": ChangeConfigData;
    Staking: StakingData;
    Vesting: VestingData;
    "Swap Request": SwapRequestData;
    Withdraw: StakingData; // Same as Staking
    Unknown: UnknownData;
}

/**
 * Extract proposal data based on type
 * @template T The proposal UI kind
 */
export type ProposalDataForType<T extends ProposalUIKind> = ProposalTypeDataMap[T];

/**
 * Helper type for proposal data extractors
 * These functions extract and normalize data from raw proposals
 */
export type ProposalDataExtractor<T extends ProposalUIKind> = (
    proposal: Proposal
) => ProposalDataForType<T> | null;


/**
 * Union type of all proposal data structures
 */
export type AnyProposalData =
    | PaymentRequestData
    | FunctionCallData
    | ChangePolicyData
    | ChangeConfigData
    | StakingData
    | VestingData
    | SwapRequestData
    | UnknownData;
