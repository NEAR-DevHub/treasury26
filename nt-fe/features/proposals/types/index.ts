import { ProposalPermissionKind } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy, VotePolicy } from "@/types/policy";

/**
 * UI representation of proposal kinds
 * This is the user-facing categorization of proposals
 */
export type ProposalUIKind =
    | "Batch Payment Request"
    | "Payment Request"
    | "Exchange"
    | "Function Call"
    | "Change Policy"
    | "Update General Settings"
    | "Earn NEAR"
    | "Unstake NEAR"
    | "Vesting"
    | "Withdraw Earnings"
    | "Members"
    | "Upgrade"
    | "Set Staking Contract"
    | "Bounty"
    | "Vote"
    | "Factory Info Update"
    | "Unsupported";

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
    type: "full" | "update_parameters" | "add_or_update_role" | "remove_role" | "update_default_vote_policy";
    policy?: Policy;
    rolesCount?: number;
    parameters?: {
        bounty_bond: string | null;
        bounty_forgiveness_period: string | null;
        proposal_bond: string | null;
        proposal_period: string | null;
    };
    role?: {
        name: string;
        permissions: string[];
        vote_policy: Record<string, VotePolicy>;
    };
    roleName?: string;
    votePolicy?: {
        weight_kind: string;
        quorum: string;
        threshold: string | [number, number] | { Weight: string } | { Ratio: [number, number] };
    };
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
    action: "stake" | "deposit" | "deposit_and_stake" | "Withdraw Earnings" | "unstake";
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
 * Data structure for Batch Payment Request proposals
 */
export interface BatchPaymentRequestData {
    tokenId: string;
    totalAmount: string;
    batchId: string;
}

/**
 * Data structure for Unknown proposals
 */
export interface UnknownData {
    proposalType: ProposalPermissionKind;
}

/**
 * Data structure for Members proposals (Add/Remove Member to/from Role)
 */
export interface MembersData {
    memberId: string;
    role: string;
    action: "add" | "remove";
}

/**
 * Data structure for Upgrade proposals (Self/Remote)
 */
export interface UpgradeData {
    hash: string;
    type: "self" | "remote";
    receiverId?: string;
    methodName?: string;
}

/**
 * Data structure for Set Staking Contract proposals
 */
export interface SetStakingContractData {
    stakingId: string;
}

/**
 * Data structure for Bounty proposals (Add/Done)
 */
export interface BountyData {
    action: "add" | "done";
    bountyId?: number;
    receiverId?: string;
    description?: string;
    token?: string;
    amount?: string;
    times?: number;
    maxDeadline?: string;
}

/**
 * Data structure for Vote proposals (signaling only)
 */
export interface VoteData {
    message: string;
}

/**
 * Data structure for Factory Info Update proposals
 */
export interface FactoryInfoUpdateData {
    factoryId: string;
    autoUpdate: boolean;
}

/**
 * Mapping of proposal types to their data structures
 */
export interface ProposalTypeDataMap {
    "Payment Request": PaymentRequestData;
    "Function Call": FunctionCallData;
    "Change Policy": ChangePolicyData;
    "Update General Settings": ChangeConfigData;
    "Earn NEAR": StakingData;
    "Unstake NEAR": StakingData;
    "Withdraw Earnings": StakingData;
    "Vesting": VestingData;
    "Exchange": SwapRequestData;
    "Batch Payment Request": BatchPaymentRequestData;
    "Members": MembersData;
    "Upgrade": UpgradeData;
    "Set Staking Contract": SetStakingContractData;
    "Bounty": BountyData;
    "Vote": VoteData;
    "Factory Info Update": FactoryInfoUpdateData;
    "Unsupported": UnknownData;
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
    | BatchPaymentRequestData
    | FunctionCallData
    | ChangePolicyData
    | ChangeConfigData
    | StakingData
    | VestingData
    | SwapRequestData
    | MembersData
    | UpgradeData
    | SetStakingContractData
    | BountyData
    | VoteData
    | FactoryInfoUpdateData
    | UnknownData;
