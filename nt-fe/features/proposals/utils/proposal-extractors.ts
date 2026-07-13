import { FunctionCallKind, Proposal } from "@/lib/proposals-api";
import {
    decodeArgs,
    decodeProposalDescription,
    formatBalance,
} from "@/lib/utils";
import { LOCKUP_NO_WHITELIST_ACCOUNT_ID } from "@/constants/config";
import {
    PaymentRequestData,
    FunctionCallData,
    ChangePolicyData,
    ChangeConfigData,
    StakingData,
    VestingData,
    SwapRequestData,
    UnknownData,
    VestingSchedule,
    AnyProposalData,
    BatchPaymentRequestData,
    ConfidentialBulkRecipient,
    ConfidentialRequestData,
    MappedConfidentialRequest,
    MembersData,
    UpgradeData,
    SetStakingContractData,
    BountyData,
    VoteData,
    FactoryInfoUpdateData,
} from "../types/index";
import { getProposalUIKind } from "./proposal-utils";
import { ProposalUIKind } from "../types/index";
import { Policy } from "@/types/policy";
import { getKindFromProposal } from "@/lib/config-utils";
import { FunctionCallAction } from "@/lib/proposals-api";
import { IntentsQuoteResponse } from "@/lib/api";
import {
    NEAR_COM_NETWORK_ID,
    NEAR_NETWORK_ID,
    WRAP_NEAR_TOKEN_ID,
} from "@/constants/network-ids";
import { NEAR_TOKEN_DECIMALS } from "@/constants/token";
import { computeQuoteNetworkFee } from "@/lib/intents-fee";

function normalizeTimeEstimateSeconds(value?: string): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const legacyMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*seconds?$/i);
    if (legacyMatch) {
        return legacyMatch[1];
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
        return parsed.toString();
    }

    return undefined;
}

function parseUsdValue(value?: string | null): number | null {
    if (value == null) {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractFTTransferData(
    functionCall: FunctionCallKind["FunctionCall"],
    actions: FunctionCallAction[],
): Omit<PaymentRequestData, "notes"> | undefined {
    const action = actions.find(
        (a) =>
            a.method_name === "ft_transfer" ||
            a.method_name === "ft_transfer_call" ||
            a.method_name === "transfer",
    );
    const actionMTTransfer = actions.find(
        (a) =>
            a.method_name === "mt_transfer" ||
            a.method_name === "mt_transfer_call",
    );
    const actionWithdraw = actions.find((a) => a.method_name === "ft_withdraw");
    const actionMTWithdraw = actions.find(
        (a) => a.method_name === "mt_withdraw",
    );

    if (action) {
        if (
            action.method_name === "transfer" &&
            !functionCall.receiver_id.endsWith(".lockup.near")
        ) {
            return undefined;
        }
        const args = decodeArgs(action.args);
        if (args) {
            const hasNearDeposit = actions.some(
                (a) => a.method_name === "near_deposit",
            );
            return {
                tokenId: hasNearDeposit
                    ? NEAR_NETWORK_ID
                    : functionCall.receiver_id,
                amount: args.amount || "0",
                receiver: args.receiver_id || "",
            };
        }
    } else if (actionMTTransfer) {
        const args = decodeArgs(actionMTTransfer.args);
        if (args) {
            return {
                tokenId: args.token_id || NEAR_NETWORK_ID,
                amount: args.amount || "0",
                receiver: args.receiver_id || "",
            };
        }
    } else if (actionWithdraw) {
        const args = decodeArgs(actionWithdraw.args);
        if (!args) {
            return undefined;
        }

        const isExternalWithdraw =
            args.receiver_id === args.token &&
            args.memo?.startsWith("WITHDRAW_TO:");
        const receiver = isExternalWithdraw
            ? args.memo.replace("WITHDRAW_TO:", "")
            : args.receiver_id;

        return {
            tokenId:
                args.token.startsWith("nep141:") ||
                args.token.startsWith("nep245:")
                    ? args.token
                    : `nep141:${args.token}`,
            amount: args.amount || "0",
            receiver,
        };
    } else if (actionMTWithdraw) {
        // NEP-245 withdrawal via mt_withdraw on intents.near
        const args = decodeArgs(actionMTWithdraw.args);
        if (!args || !args.amounts || !args.token_ids) {
            return undefined;
        }

        const tokenId = args.token_ids[0]
            ? args.token_ids[0].startsWith("nep245:")
                ? args.token_ids[0]
                : `nep245:${args.token}:${args.token_ids[0]}`
            : `nep245:${functionCall.receiver_id}:${args.token_ids[0]}`;

        return {
            tokenId,
            amount: args.amounts[0] || "0",
            receiver:
                args.memo?.replace("WITHDRAW_TO:", "") || args.receiver_id,
        };
    }
    return undefined;
}

/**
 * Extract Payment Request data from proposal
 */
export function extractPaymentRequestData(
    proposal: Proposal,
): PaymentRequestData {
    let tokenId = NEAR_NETWORK_ID;
    let amount = "0";
    let receiver = "";
    const proposalAction = decodeProposalDescription(
        "proposal action",
        proposal.description,
    );

    let isTransferKind = false;

    if ("Transfer" in proposal.kind) {
        isTransferKind = true;
        const transfer = proposal.kind.Transfer;
        const normalizedTokenId = transfer.token_id?.trim();
        tokenId =
            normalizedTokenId && normalizedTokenId.length > 0
                ? normalizedTokenId
                : NEAR_NETWORK_ID;
        amount = transfer.amount;
        receiver = transfer.receiver_id;
    } else if ("FunctionCall" in proposal.kind) {
        const functionCall = proposal.kind.FunctionCall;
        const actions = functionCall.actions;
        const ftTransferData = extractFTTransferData(functionCall, actions);
        if (ftTransferData) {
            tokenId = ftTransferData.tokenId;
            amount = ftTransferData.amount;
            receiver = ftTransferData.receiver;
        }
    } else {
        throw new Error("Proposal is not a Function Call or Transfer proposal");
    }

    const notes = decodeProposalDescription("notes", proposal.description);
    const title = decodeProposalDescription("title", proposal.description);
    const url = decodeProposalDescription("url", proposal.description);
    const describedRecipient = decodeProposalDescription(
        "recipient",
        proposal.description,
    );

    if (proposalAction === "payment-transfer" && describedRecipient) {
        receiver = describedRecipient;
    }

    // Intents routing metadata (only present on proposals created via 1Click)
    const depositAddress = decodeProposalDescription(
        "depositAddress",
        proposal.description,
    );
    const quoteSignature = decodeProposalDescription(
        "signature",
        proposal.description,
    );
    const networkFee = decodeProposalDescription(
        "networkFee",
        proposal.description,
    );
    let destinationAssetId = decodeProposalDescription(
        "destinationNetwork",
        proposal.description,
    );

    // Transfer proposals are always on-chain NEAR; set explicit destination
    // network so request details do not depend on token metadata.
    if (!destinationAssetId && isTransferKind && !depositAddress) {
        destinationAssetId = NEAR_NETWORK_ID;
    }

    // Non-Transfer native NEAR payments without 1Click metadata also resolve
    // to NEAR network in destination display.
    if (!destinationAssetId && tokenId === NEAR_NETWORK_ID && !depositAddress) {
        destinationAssetId = NEAR_NETWORK_ID;
    }
    const goldAmountOutUsd = parseUsdValue(
        proposal.public_metadata?.gold_metadata?.amount_out_usd,
    );

    return {
        tokenId,
        amount,
        receiver,
        notes: title ? title : notes,
        url: url || "",
        depositAddress,
        quoteSignature,
        networkFee,
        destinationAssetId,
        nearFt: isTransferKind || undefined,
        usdValue: goldAmountOutUsd,
    };
}

/**
 * Extract Function Call data from proposal
 */
export function extractFunctionCallData(proposal: Proposal): FunctionCallData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Function Call proposal");
    }

    const functionCall = proposal.kind.FunctionCall;
    return {
        receiver: functionCall.receiver_id,
        actions: functionCall.actions.map((action) => ({
            methodName: action.method_name,
            args: decodeArgs(action.args),
            gas: action.gas,
            deposit: action.deposit,
        })),
    };
}

/**
 * Extract Change Policy data from proposal
 */
export function extractChangePolicyData(proposal: Proposal): ChangePolicyData {
    let newPolicy: Policy | null = null;

    if ("ChangePolicy" in proposal.kind) {
        newPolicy = proposal.kind.ChangePolicy.policy as Policy;
    }

    return {
        newPolicy,
        originalProposalKind: proposal.kind,
    };
}

/**
 * Extract Change Config data from proposal
 */
export function extractChangeConfigData(proposal: Proposal): ChangeConfigData {
    if (!("ChangeConfig" in proposal.kind)) {
        throw new Error("Proposal is not a Change Config proposal");
    }

    const changeConfig = proposal.kind.ChangeConfig;
    const { metadata, purpose, name } = changeConfig.config;
    const metadataFromBase64 = decodeArgs(metadata) || {};

    return {
        newConfig: {
            name,
            purpose,
            metadata: metadataFromBase64,
        },
    };
}

/**
 * Extract Staking data from proposal
 */
export function extractStakingData(proposal: Proposal): StakingData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Staking proposal");
    }

    const functionCall = proposal.kind.FunctionCall;
    const isLockup = functionCall.receiver_id.endsWith("lockup.near");
    const actions = functionCall.actions;

    const stakingAction = actions.find(
        (action) =>
            action.method_name === "stake" ||
            action.method_name === "deposit_and_stake" ||
            action.method_name === "deposit",
    );
    const withdrawAction = actions.find(
        (action) =>
            action.method_name === "unstake_all" ||
            action.method_name === "unstake" ||
            action.method_name === "withdraw_all" ||
            action.method_name === "withdraw_all_from_staking_pool" ||
            action.method_name === "withdraw",
    );

    const selectedAction = stakingAction || withdrawAction;
    const args = selectedAction ? decodeArgs(selectedAction.args) : null;
    const isFullAmount =
        selectedAction?.method_name === "unstake_all" ||
        selectedAction?.method_name === "withdraw_all" ||
        selectedAction?.method_name === "withdraw_all_from_staking_pool";

    const notes = decodeProposalDescription("notes", proposal.description);
    const withdrawAmount = decodeProposalDescription(
        "amount",
        proposal.description,
    );

    return {
        tokenId: NEAR_NETWORK_ID,
        amount: isFullAmount
            ? "0"
            : args?.amount || stakingAction?.deposit || withdrawAmount || "0",
        receiver: functionCall.receiver_id,
        action:
            (selectedAction?.method_name as StakingData["action"]) || "stake",
        sourceWallet: isLockup ? "Lockup" : "Wallet",
        validatorUrl: `https://nearblocks.io/node-explorer/${functionCall.receiver_id}`,
        isLockup,
        lockupPool: isLockup ? functionCall.receiver_id : "",
        notes: notes || "",
        isFullAmount,
    };
}

/**
 * Extract Vesting data from proposal
 */
export function extractVestingData(proposal: Proposal): VestingData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Vesting proposal");
    }

    const functionCall = proposal.kind.FunctionCall;
    const firstAction = functionCall.actions[0];

    if (!firstAction || firstAction.method_name !== "create") {
        return {
            tokenId: NEAR_NETWORK_ID,
            amount: "0",
            receiver: "",
            vestingSchedule: null,
            whitelistAccountId: "",
            foundationAccountId: "",
            allowCancellation: false,
            allowStaking: false,
            notes: "",
        };
    }

    const args = decodeArgs(firstAction.args);
    if (!args) {
        return {
            tokenId: NEAR_NETWORK_ID,
            amount: "0",
            receiver: "",
            vestingSchedule: null,
            whitelistAccountId: "",
            foundationAccountId: "",
            allowCancellation: false,
            allowStaking: false,
            notes: "",
        };
    }

    const vestingScheduleRaw = args.vesting_schedule?.VestingSchedule;
    const vestingSchedule: VestingSchedule | null = vestingScheduleRaw
        ? {
              start_timestamp: vestingScheduleRaw.start_timestamp,
              end_timestamp: vestingScheduleRaw.end_timestamp,
              cliff_timestamp: vestingScheduleRaw.cliff_timestamp,
          }
        : null;

    const whitelistAccountId = args.whitelist_account_id || "";
    const foundationAccountId = args.foundation_account_id || "";
    const recipient = args.owner_account_id || "";
    const notes = decodeProposalDescription("notes", proposal.description);

    return {
        tokenId: NEAR_NETWORK_ID,
        amount: firstAction.deposit,
        receiver: recipient,
        vestingSchedule,
        whitelistAccountId,
        foundationAccountId,
        allowCancellation: !!foundationAccountId,
        allowStaking: whitelistAccountId !== LOCKUP_NO_WHITELIST_ACCOUNT_ID,
        notes: notes || "",
    };
}

/**
 * Extract Exchange data from proposal
 */
export function extractExchangeRequestData(
    proposal: Proposal,
): SwapRequestData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Exchange proposal");
    }

    const functionCall = proposal.kind.FunctionCall;

    // For NEAR exchanges, we need to find the transfer action
    // Filter out near_deposit and storage_deposit actions and find the actual transfer
    // Support both ft_transfer (new) and ft_transfer_call (legacy) for backward compatibility
    const action = functionCall.actions.find(
        (a) =>
            a.method_name !== "near_deposit" &&
            a.method_name !== "storage_deposit" &&
            (a.method_name === "mt_transfer" ||
                a.method_name === "ft_transfer" ||
                a.method_name === "ft_transfer_call"), // Legacy support
    );

    if (!action) {
        throw new Error("Proposal is not a Exchange proposal");
    }

    const args = decodeArgs(action.args);
    if (!args) {
        throw new Error("Proposal is not a Exchange proposal");
    }

    // Extract from description
    // NEW FORMAT: proposals have tokenInAddress and tokenOutAddress
    // LEGACY FORMAT: proposals have tokenIn (symbol), tokenOut (symbol), and destinationNetwork
    const tokenInSymbol =
        decodeProposalDescription("tokenIn", proposal.description) || "";
    const tokenInAddress =
        decodeProposalDescription("tokenInAddress", proposal.description) || "";
    const tokenOutSymbol =
        decodeProposalDescription("tokenOut", proposal.description) || "";
    const tokenOutAddress =
        decodeProposalDescription("tokenOutAddress", proposal.description) ||
        "";
    const destinationNetwork = decodeProposalDescription(
        "destinationNetwork",
        proposal.description,
    );
    const amountIn =
        args.amount ||
        decodeProposalDescription("amountIn", proposal.description) ||
        "0";
    const amountOut =
        decodeProposalDescription("amountOut", proposal.description) || "0";
    const slippage = decodeProposalDescription(
        "slippage",
        proposal.description,
    );

    const intentsTokenContractId = args.token_id?.startsWith("nep141:")
        ? args.token_id.replace("nep141:", "")
        : args.token_id;
    const quoteDeadline = decodeProposalDescription(
        "quoteDeadline",
        proposal.description,
    );
    const quoteSignature = decodeProposalDescription(
        "signature",
        proposal.description,
    );
    const timeEstimateRaw = decodeProposalDescription(
        "timeEstimate",
        proposal.description,
    );
    const timeEstimate = normalizeTimeEstimateSeconds(timeEstimateRaw);

    // Determine tokenIn and depositAddress based on proposal structure:
    // 1. Native NEAR: ft_transfer from wrap.near WITH near_deposit action, tokenIn = near
    // 2. FT tokens on NEAR: ft_transfer from token contract, depositAddress in receiver_id, tokenIn = token contract
    // 3. Intents tokens: mt_transfer to intents.near with token_id, depositAddress in receiver_id
    // 4. Legacy ft_transfer_call/mt_transfer_call: same logic as above
    let tokenIn: string;
    let depositAddress: string;

    if (
        action.method_name === "mt_transfer" ||
        action.method_name === "mt_transfer_call"
    ) {
        // Intents tokens: token_id and depositAddress are in args directly
        tokenIn = args.token_id || "";
        depositAddress = args.receiver_id || "";
    } else if (
        action.method_name === "ft_transfer" ||
        action.method_name === "ft_transfer_call"
    ) {
        // ft_transfer/ft_transfer_call: depositAddress is directly in receiver_id, tokenIn is the contract being called
        depositAddress = args.receiver_id || "";

        // Check if there's a near_deposit action - if so, it's a Native NEAR exchange
        const hasNearDeposit = functionCall.actions.some(
            (a) => a.method_name === "near_deposit",
        );

        if (hasNearDeposit && functionCall.receiver_id === WRAP_NEAR_TOKEN_ID) {
            // Native NEAR exchange: near -> other token
            tokenIn = NEAR_NETWORK_ID;
        } else {
            // FT token or wNEAR exchange
            tokenIn = functionCall.receiver_id;
        }
    } else {
        // Fallback
        depositAddress = args.receiver_id || "";
        tokenIn = "";
    }
    const goldAmountInUsd = parseUsdValue(
        proposal.public_metadata?.gold_metadata?.amount_in_usd,
    );
    const goldAmountOutUsd = parseUsdValue(
        proposal.public_metadata?.gold_metadata?.amount_out_usd,
    );

    return {
        source: "exchange",
        tokenIn,
        tokenInSymbol, // LEGACY: for old proposals with symbols
        tokenInAddress, // NEW: for new proposals with addresses
        tokenOut: tokenOutSymbol, // LEGACY: for old proposals with symbols
        tokenOutAddress, // NEW: for new proposals with addresses
        intentsTokenContractId,
        amountIn,
        amountInUsd: goldAmountInUsd,
        amountOut,
        amountOutUsd: goldAmountOutUsd,
        destinationNetwork, // LEGACY: for old proposals
        sourceNetwork: NEAR_NETWORK_ID,
        quoteSignature,
        depositAddress,
        timeEstimate,
        slippage: slippage || undefined,
        quoteDeadline: quoteDeadline || undefined,
    };
}

export function extractNearWrapSwapRequestData(
    proposal: Proposal,
): SwapRequestData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Exchange proposal");
    }

    const functionCall = proposal.kind.FunctionCall;
    const action = functionCall.actions.find(
        (a) =>
            a.method_name === "near_withdraw" ||
            a.method_name === "near_deposit",
    );
    if (!action) {
        throw new Error("Proposal is not a Exchange proposal");
    }

    const args = decodeArgs(action.args);
    if (!args) {
        throw new Error("Proposal is not a Exchange proposal");
    }
    const isWrap = action.method_name === "near_deposit";
    const amountRaw = isWrap ? action.deposit || "0" : args.amount || "0";
    const amountFormatted = formatBalance(amountRaw, NEAR_TOKEN_DECIMALS);

    return {
        source: WRAP_NEAR_TOKEN_ID,
        tokenIn: isWrap ? NEAR_NETWORK_ID : WRAP_NEAR_TOKEN_ID,
        amountIn: amountFormatted,
        tokenOut: isWrap ? WRAP_NEAR_TOKEN_ID : NEAR_NETWORK_ID,
        amountOut: amountFormatted,
        destinationNetwork: NEAR_NETWORK_ID,
        sourceNetwork: NEAR_NETWORK_ID,
    };
}

/**
 * Extract Batch Payment Request data from proposal
 */
export function extractBatchPaymentRequestData(
    proposal: Proposal,
): BatchPaymentRequestData {
    if (!("FunctionCall" in proposal.kind)) {
        throw new Error("Proposal is not a Batch Payment Request proposal");
    }

    const functionCall = proposal.kind.FunctionCall;
    const action = functionCall.actions.find(
        (a) =>
            a.method_name === "ft_transfer_call" ||
            a.method_name === "approve_list" ||
            a.method_name === "mt_transfer_call",
    );

    if (!action) {
        throw new Error("Proposal is not a Batch Payment Request proposal");
    }

    const args = decodeArgs(action.args);
    if (!args) {
        throw new Error("Proposal is not a Batch Payment Request proposal");
    }

    let tokenId: string;
    let totalAmount: string;
    let batchId: string;

    // Handle NEAR payments (approve_list)
    if (action.method_name === "approve_list") {
        tokenId = NEAR_NETWORK_ID;
        totalAmount = action.deposit;
        batchId = args.list_id || "";
    }
    // Handle Intents tokens (mt_transfer_call)
    // Token ID is in args.token_id (e.g., "nep141:btc.omft.near")
    else if (action.method_name === "mt_transfer_call") {
        tokenId = args.token_id || functionCall.receiver_id;
        totalAmount = args.amount || "0";
        batchId = String(args.msg) || "";
    }
    // Handle FT tokens (ft_transfer_call)
    // Token ID is the contract being called (receiver_id)
    else {
        tokenId = functionCall.receiver_id;
        totalAmount = args.amount || "0";
        batchId = String(args.msg) || "";
    }

    // Extract notes and URL from proposal description (same as single payments)
    const notes = decodeProposalDescription("notes", proposal.description);
    const title = decodeProposalDescription("title", proposal.description);

    return {
        tokenId,
        totalAmount,
        batchId,
        notes: title ? title : notes,
    };
}

/**
 * Extract Members data from proposal (Add/Remove Member to/from Role)
 */
export function extractMembersData(proposal: Proposal): MembersData {
    if ("AddMemberToRole" in proposal.kind) {
        const data = proposal.kind.AddMemberToRole;
        return {
            memberId: data.member_id,
            role: data.role,
            action: "add",
        };
    }

    if ("RemoveMemberFromRole" in proposal.kind) {
        const data = proposal.kind.RemoveMemberFromRole;
        return {
            memberId: data.member_id,
            role: data.role,
            action: "remove",
        };
    }

    throw new Error("Proposal is not a Members proposal");
}

/**
 * Extract Upgrade data from proposal (Self/Remote)
 */
export function extractUpgradeData(proposal: Proposal): UpgradeData {
    if ("UpgradeSelf" in proposal.kind) {
        const data = proposal.kind.UpgradeSelf;
        return {
            hash: data.hash,
            type: "self",
        };
    }

    if ("UpgradeRemote" in proposal.kind) {
        const data = proposal.kind.UpgradeRemote;
        return {
            hash: data.hash,
            type: "remote",
            receiverId: data.receiver_id,
            methodName: data.method_name,
        };
    }

    throw new Error("Proposal is not an Upgrade proposal");
}

/**
 * Extract Set Staking Contract data from proposal
 */
export function extractSetStakingContractData(
    proposal: Proposal,
): SetStakingContractData {
    if (!("SetStakingContract" in proposal.kind)) {
        throw new Error("Proposal is not a Set Staking Contract proposal");
    }

    const data = proposal.kind.SetStakingContract;
    return {
        stakingId: data.staking_id,
    };
}

/**
 * Extract Bounty data from proposal (Add/Done)
 */
export function extractBountyData(proposal: Proposal): BountyData {
    if ("AddBounty" in proposal.kind) {
        const bounty = proposal.kind.AddBounty.bounty;
        return {
            action: "add",
            description: bounty.description,
            token: bounty.token,
            amount: bounty.amount,
            times: bounty.times,
            maxDeadline: bounty.max_deadline,
        };
    }

    if ("BountyDone" in proposal.kind) {
        const data = proposal.kind.BountyDone;
        return {
            action: "done",
            bountyId: data.bounty_id,
            receiverId: data.receiver_id,
        };
    }

    throw new Error("Proposal is not a Bounty proposal");
}

/**
 * Extract Vote data from proposal
 */
export function extractVoteData(proposal: Proposal): VoteData {
    if (!("Vote" in proposal.kind)) {
        throw new Error("Proposal is not a Vote proposal");
    }

    return {
        message: proposal.description || "Vote proposal (signaling only)",
    };
}

/**
 * Extract Factory Info Update data from proposal
 */
export function extractFactoryInfoUpdateData(
    proposal: Proposal,
): FactoryInfoUpdateData {
    if (!("FactoryInfoUpdate" in proposal.kind)) {
        throw new Error("Proposal is not a Factory Info Update proposal");
    }

    const factoryInfo = proposal.kind.FactoryInfoUpdate.factory_info;
    return {
        factoryId: factoryInfo.factory_id,
        autoUpdate: factoryInfo.auto_update,
    };
}

/**
 * Extract Unknown proposal data
 */
export function extractUnknownData(proposal: Proposal): UnknownData {
    const proposalType = getKindFromProposal(proposal.kind);
    return {
        proposalType,
    };
}

/**
 * Extract Confidential Transfer data from proposal.
 * Quote metadata is populated by the backend from the confidential_intents table.
 */
export function extractConfidentialRequestData(
    proposal: Proposal,
    treasuryId?: string,
): ConfidentialRequestData {
    const correlationId =
        decodeProposalDescription("correlationId", proposal.description) ??
        undefined;

    // Extract payloadHash from the v1.signer FunctionCall args
    let payloadHash: string | undefined;
    if ("FunctionCall" in proposal.kind) {
        const action = proposal.kind.FunctionCall.actions[0];
        if (action?.args) {
            try {
                const args = decodeArgs(action.args);
                payloadHash = args?.request?.payload_v2?.Eddsa;
            } catch {
                // ignore decode errors
            }
        }
    }

    const meta = proposal.confidential_metadata;
    const quoteMeta = meta?.quote_metadata;
    const goldAmountInUsd = parseUsdValue(meta?.gold_metadata?.amount_in_usd);
    const goldAmountOutUsd = parseUsdValue(meta?.gold_metadata?.amount_out_usd);

    let mapped: MappedConfidentialRequest = null;
    let title = "Confidential Request";

    // Bulk overlay (BE-attached when description carries `payload_hashes`).
    // Takes precedence over single-quote mapping — header quote is not the
    // user-facing transfer; per-recipient quotes are.
    if (meta?.bulk) {
        const bulk = meta.bulk;
        const recipients: ConfidentialBulkRecipient[] = bulk.recipients.map(
            (r) => ({
                payloadHash: r.payload_hash,
                quoteMetadata: r.quote_metadata,
                status: r.status,
                submitResult: r.submit_result,
            }),
        );

        // Token + total come from the **header** quote — that's the actual
        // on-chain spend (DAO → sub). Recipients are downstream legs paid
        // out of the sub balance and are surfaced in the expanded view.
        const tokenId = quoteMeta?.quoteRequest?.originAsset ?? "";
        const totalAmount = quoteMeta?.quote?.amountIn ?? "0";

        mapped = {
            type: "bulk",
            data: {
                bulkAccountId: bulk.bulk_account_id,
                bulkStatus: bulk.status,
                tokenId,
                totalAmount,
                recipients,
                notes: meta.notes,
            },
        };
        title = "Confidential Bulk Payment";

        return {
            correlationId,
            payloadHash,
            status: meta.status,
            mapped,
            title,
        };
    }

    if (quoteMeta) {
        const quoteResponse = {
            ...quoteMeta,
            correlationId,
        } as unknown as IntentsQuoteResponse;
        const quote = quoteResponse.quote;
        const quoteRequest = quoteResponse.quoteRequest;
        const isSwap = quoteRequest.recipient === treasuryId;

        if (isSwap) {
            mapped = {
                type: "swap",
                data: {
                    source: "exchange",
                    timeEstimate: quote.timeEstimate.toString(),
                    quoteSignature: quoteResponse.signature,
                    depositAddress: quote.depositAddress,
                    tokenInAddress: quoteRequest.originAsset,
                    amountIn: quote.amountIn,
                    amountInUsd: goldAmountInUsd,
                    tokenOutAddress: quoteRequest.destinationAsset,
                    amountOut: quote.amountOutFormatted,
                    amountOutUsd: goldAmountOutUsd,
                    slippage: (
                        (quoteRequest.slippageTolerance ?? 0) / 100
                    ).toString(),
                    quoteDeadline: quote.deadline,
                } as SwapRequestData,
            };
            title = "Confidential Exchange";
        } else {
            const destinationAsset = quoteRequest.destinationAsset;
            const recipient = quoteRequest.recipient ?? "";
            const recipientType =
                typeof quoteRequest.recipientType === "string"
                    ? quoteRequest.recipientType
                    : undefined;
            const isNearComIntentsRoute =
                recipientType === "CONFIDENTIAL_INTENTS";
            const destinationAssetId = isNearComIntentsRoute
                ? NEAR_COM_NETWORK_ID
                : destinationAsset;
            const networkFee = computeQuoteNetworkFee(quote);
            mapped = {
                type: "payment",
                data: {
                    tokenId: quoteRequest.originAsset,
                    amount: quote.amountIn,
                    quoteAmountInUsd: quote.amountInUsd,
                    receiver: recipient,
                    notes: meta?.notes ?? undefined,
                    depositAddress: quote.depositAddress,
                    quoteSignature: quoteResponse.signature,
                    networkFee,
                    usdValue: goldAmountInUsd,
                    destinationAssetId,
                } as PaymentRequestData,
            };
            title = "Confidential Payment";
        }
    }

    return {
        correlationId,
        payloadHash,
        status: meta?.status,
        proposalCreatedAt: meta?.proposal_created_at,
        executedAt: meta?.proposal_executed_at,
        mapped,
        title,
    };
}

/**
 * Main extractor that routes to the appropriate extractor based on proposal type
 */
export function extractProposalData(
    proposal: Proposal,
    treasuryId?: string,
): {
    type: ProposalUIKind;
    data: AnyProposalData;
} {
    const type = getProposalUIKind(proposal);
    let data: AnyProposalData;

    switch (type) {
        case "Payment Request":
            data = extractPaymentRequestData(proposal);
            break;
        case "Confidential Request":
            data = extractConfidentialRequestData(proposal, treasuryId);
            break;
        case "Function Call":
            data = extractFunctionCallData(proposal);
            break;
        case "Batch Payment Request":
            data = extractBatchPaymentRequestData(proposal);
            break;
        case "Change Policy":
            data = extractChangePolicyData(proposal);
            break;
        case "Update General Settings":
            data = extractChangeConfigData(proposal);
            break;
        case "Earn NEAR":
        case "Unstake NEAR":
        case "Withdraw Earnings":
            data = extractStakingData(proposal);
            break;
        case "Vesting":
            data = extractVestingData(proposal);
            break;
        case "Exchange":
            if ("FunctionCall" in proposal.kind) {
                const functionCall = proposal.kind.FunctionCall;

                // Check if this is a simple wrap/unwrap (no exchange)
                const isSimpleWrapUnwrap =
                    functionCall.receiver_id === WRAP_NEAR_TOKEN_ID &&
                    functionCall.actions.length === 1 &&
                    functionCall.actions.some(
                        (action) =>
                            action.method_name === "near_withdraw" ||
                            action.method_name === "near_deposit",
                    );

                if (isSimpleWrapUnwrap) {
                    // Simple wrap/unwrap NEAR ↔ wNEAR
                    data = extractNearWrapSwapRequestData(proposal);
                } else {
                    // Exchange proposal (cross-chain swap)
                    data = extractExchangeRequestData(proposal);
                }
            } else {
                throw new Error("Proposal is not a Exchange proposal");
            }
            break;
        case "Members":
            data = extractMembersData(proposal);
            break;
        case "Upgrade":
            data = extractUpgradeData(proposal);
            break;
        case "Set Staking Contract":
            data = extractSetStakingContractData(proposal);
            break;
        case "Bounty":
            data = extractBountyData(proposal);
            break;
        case "Vote":
            data = extractVoteData(proposal);
            break;
        case "Factory Info Update":
            data = extractFactoryInfoUpdateData(proposal);
            break;
        case "Unsupported":
        default:
            data = extractUnknownData(proposal);
            break;
    }

    return { type, data };
}
