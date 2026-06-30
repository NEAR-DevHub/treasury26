import { ProposalPermissionKind } from "@/lib/config-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { WRAP_NEAR_TOKEN_ID } from "@/constants/network-ids";

/**
 * UI representation of proposal kinds
 * This is the user-facing categorization of proposals
 */
export type ProposalUIKind =
    | "Batch Payment Request"
    | "Payment Request"
    | "Confidential Request"
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
    notes?: string;
    url?: string;
    /** Present when the payment was routed through the 1Click Intents protocol */
    depositAddress?: string;
    quoteSignature?: string;
    /** Network fee in token units (not raw smallest units) */
    networkFee?: string;
    /** USD value from confidential gold projection. null means intentionally hidden/missing. */
    usdValue?: number | null;
    /** Destination id (e.g. "near.com", "near", "nep141:...omft.near") */
    destinationAssetId?: string;
    /** Optional quote-provided USD value for display */
    quoteAmountInUsd?: string;
    /** True for plain Transfer proposals — enables NearBlocks FT metadata fallback */
    nearFt?: boolean;
}

export interface FunctionCallAction {
    methodName: string;
    args: Record<string, any>;
    gas: string;
    deposit: string;
}

/**
 * Data structure for Function Call proposals
 */
export interface FunctionCallData {
    receiver: string;
    actions: FunctionCallAction[];
}

export interface PolicyChange {
    field:
        | "proposal_bond"
        | "proposal_period"
        | "bounty_bond"
        | "bounty_forgiveness_period";
    oldValue: string | null;
    newValue: string | null;
}

export interface MemberRoleChange {
    member: string;
    oldRoles?: string[] | null; // Previous roles (groups) the member was assigned to
    newRoles?: string[] | null; // New roles (groups) the member is assigned to
}

export interface RoleDefinitionChange {
    roleName: string;
    proposalKind: string;
    oldThreshold?: any;
    newThreshold?: any;
    oldQuorum?: string | null;
    newQuorum?: string | null;
    oldWeightKind?: string | null;
    newWeightKind?: string | null;
    oldPermissions?: string[] | null;
    newPermissions?: string[] | null;
}

export interface RoleChange {
    addedMembers: MemberRoleChange[];
    removedMembers: MemberRoleChange[];
    updatedMembers: MemberRoleChange[];
    roleDefinitionChanges: RoleDefinitionChange[];
}

export interface VotePolicyChange {
    field: "weight_kind" | "quorum" | "threshold";
    oldValue: any;
    newValue: any;
}

/**
 * Data structure for Change Policy proposals
 * Unified representation showing only what changed
 */
export interface ChangePolicyData {
    newPolicy: Policy | null;
    originalProposalKind: any; // Store the original proposal kind for Transaction Details
}

/**
 * Data structure for Change Config proposals
 */
export interface ChangeConfigData {
    newConfig: {
        name: string;
        purpose: string;
        metadata: Record<string, any>;
    };
}

/**
 * Data structure for Staking proposals (and Withdraw)
 */
export interface StakingData {
    tokenId: string;
    amount: string;
    receiver: string;
    action:
        | "stake"
        | "deposit"
        | "deposit_and_stake"
        | "withdraw"
        | "withdraw_all"
        | "withdraw_all_from_staking_pool"
        | "unstake"
        | "unstake_all";
    sourceWallet: "Lockup" | "Wallet";
    validatorUrl: string;
    isLockup: boolean;
    lockupPool: string;
    notes: string;
    isFullAmount: boolean;
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

/**
 * Data structure for Confidential Transfer proposals (v1.signer signing proposals).
 * Quote metadata is populated from the backend's confidential_intents table.
 */
export type MappedConfidentialRequest =
    | { type: "swap"; data: SwapRequestData }
    | { type: "payment"; data: PaymentRequestData }
    | { type: "bulk"; data: ConfidentialBulkData }
    | null;

export interface ConfidentialRequestData {
    correlationId?: string;
    payloadHash?: string;
    status?: string;
    proposalCreatedAt?: string | null;
    executedAt?: string | null;
    mapped?: MappedConfidentialRequest;
    title: string;
}

export interface SwapRequestData {
    source: "exchange" | typeof WRAP_NEAR_TOKEN_ID;
    timeEstimate?: string;
    intentsTokenContractId?: string;
    quoteSignature?: string;
    depositAddress?: string;
    tokenIn: string; // Token ID extracted from actions (e.g., "wrap.near")
    tokenInSymbol?: string; // LEGACY: Token symbol for old proposals (e.g., "NEAR")
    tokenInAddress?: string; // NEW: Token address for new proposals (e.g., "near")
    sourceNetwork: string;
    destinationNetwork?: string; // LEGACY: Destination network - only for old proposals
    amountIn: string;
    amountInUsd?: number | null;
    tokenOut: string; // Token symbol (LEGACY for old proposals, empty for new ones)
    tokenOutAddress?: string; // NEW: Token address for new proposals
    amountOut: string;
    amountOutUsd?: number | null;
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
    notes?: string;
}

/**
 * Per-recipient row inside a confidential bulk payment.
 *
 * `quoteMetadata` is the full 1Click quote returned at prepare time —
 * recipient address, amount, destinationAsset, depositAddress, etc. all live
 * inside its `quote` and `quoteRequest` sub-objects (same shape as the
 * single-confidential `ConfidentialRequestData.mapped.data`).
 */
export interface ConfidentialBulkRecipient {
    payloadHash: string;
    quoteMetadata?: Record<string, unknown> | null;
    /** pending | submitted | failed | missing */
    status: string;
    submitResult?: Record<string, unknown> | null;
}

/**
 * Bulk-confidential payload mapped from `confidential_metadata.bulk`.
 * Surfaced as `ConfidentialRequestData.mapped` with `type: "bulk"`, so the
 * single Confidential Request UIKind handles both legs (single + bulk).
 */
export interface ConfidentialBulkData {
    /** Sub-account that signs each recipient leg. */
    bulkAccountId?: string;
    /** pending | activating | signing | completed | failed (BE state machine) */
    bulkStatus?: string;
    /** Origin asset id (Intents) — uniform across recipients. */
    tokenId: string;
    /** Sum of recipient amounts in smallest units. */
    totalAmount: string;
    /** Notes for the proposal */
    notes?: string;
    /** Per-recipient rows from the linked `confidential_intents` rows. */
    recipients: ConfidentialBulkRecipient[];
}

/**
 * Data structure for Unknown proposals
 */
export interface UnknownData {
    proposalType?: ProposalPermissionKind;
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
    "Confidential Request": ConfidentialRequestData;
    "Function Call": FunctionCallData;
    "Change Policy": ChangePolicyData;
    "Update General Settings": ChangeConfigData;
    "Earn NEAR": StakingData;
    "Unstake NEAR": StakingData;
    "Withdraw Earnings": StakingData;
    Vesting: VestingData;
    Exchange: SwapRequestData;
    "Batch Payment Request": BatchPaymentRequestData;
    Members: MembersData;
    Upgrade: UpgradeData;
    "Set Staking Contract": SetStakingContractData;
    Bounty: BountyData;
    Vote: VoteData;
    "Factory Info Update": FactoryInfoUpdateData;
    Unsupported: UnknownData;
}

/**
 * Extract proposal data based on type
 * @template T The proposal UI kind
 */
export type ProposalDataForType<T extends ProposalUIKind> =
    ProposalTypeDataMap[T];

/**
 * Helper type for proposal data extractors
 * These functions extract and normalize data from raw proposals
 */
export type ProposalDataExtractor<T extends ProposalUIKind> = (
    proposal: Proposal,
) => ProposalDataForType<T> | null;

/**
 * Union type of all proposal data structures
 */
export type AnyProposalData =
    | PaymentRequestData
    | BatchPaymentRequestData
    | ConfidentialRequestData
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
