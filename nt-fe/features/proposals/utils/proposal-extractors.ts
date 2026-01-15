import { FunctionCallKind, Proposal } from "@/lib/proposals-api";
import { decodeArgs, decodeProposalDescription } from "@/lib/utils";
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
import { Action } from "@hot-labs/near-connect/build/types";
import { getKindFromProposal } from "@/lib/config-utils";


function extractFTTransferData(functionCall: FunctionCallKind["FunctionCall"], actions: Action[]): Omit<PaymentRequestData, "notes"> | undefined {
  const action = actions.find(
    (a) => a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call"
  );
  const actionWithdraw = actions.find(
    (a) => a.method_name === "ft_withdraw"
  );
  if (action) {
    const args = decodeArgs(action.args);
    if (args) {
      return {
        tokenId: functionCall.receiver_id,
        amount: args.amount || "0",
        receiver: args.receiver_id || "",
      };
    }
  } else if (actionWithdraw) {
    const args = decodeArgs(actionWithdraw.args);
    if (!args) {
      return undefined;
    }
    const isExternalWithdraw = args.receiver_id === functionCall.receiver_id;
    const receiver = isExternalWithdraw ? args.memo.replace("WITHDRAW_TO:", "") : args.receiver_id;

    return {
      tokenId: `nep141:${args.token}`,
      amount: args.amount || "0",
      receiver,
    }
  }
  return undefined;
}

/**
 * Extract Payment Request data from proposal
 */
export function extractPaymentRequestData(proposal: Proposal): PaymentRequestData {
  let tokenId = "near";
  let amount = "0";
  let receiver = "";

  if ("Transfer" in proposal.kind) {
    const transfer = proposal.kind.Transfer;
    tokenId = transfer.token_id.length > 0 ? transfer.token_id : "near";
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

  return {
    tokenId,
    amount,
    receiver,
    notes: title ? title : notes,
    url: url || "",
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
  const action = functionCall.actions[0];
  const args = action ? decodeArgs(action.args) : {};

  return {
    receiver: functionCall.receiver_id,
    methodName: action?.method_name || "",
    actionsCount: functionCall.actions.length,
    gas: action?.gas || "0",
    deposit: action?.deposit || "0",
    args: args || {},
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
      action.method_name === "deposit"
  );
  const withdrawAction = actions.find(
    (action) => action.method_name === "Withdraw Earnings" || action.method_name === "unstake"
  );

  const selectedAction = stakingAction || withdrawAction;
  const args = selectedAction ? decodeArgs(selectedAction.args) : null;

  const notes = decodeProposalDescription("notes", proposal.description);
  const withdrawAmount = decodeProposalDescription(
    "amount",
    proposal.description
  );

  return {
    tokenId: "near",
    amount: args?.amount || withdrawAmount || "0",
    receiver: functionCall.receiver_id,
    action: (selectedAction?.method_name as StakingData["action"]) || "stake",
    sourceWallet: isLockup ? "Lockup" : "Wallet",
    validatorUrl: `https://nearblocks.io/node-explorer/${functionCall.receiver_id}`,
    isLockup,
    lockupPool: isLockup ? functionCall.receiver_id : "",
    notes: notes || "",
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
      tokenId: "near",
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
      tokenId: "near",
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
    tokenId: "near",
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
export function extractExchangeRequestData(proposal: Proposal): SwapRequestData {
  if (!("FunctionCall" in proposal.kind)) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  const functionCall = proposal.kind.FunctionCall;
  const action = functionCall.actions.find(
    (a) => a.method_name === "mt_transfer" || a.method_name === "mt_transfer_call" || a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call"
  );

  if (!action) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  const args = decodeArgs(action?.args);
  if (!args) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  // Extract from description
  const amountIn = args.amount || decodeProposalDescription("amountIn", proposal.description) || "0";
  const tokenOut = decodeProposalDescription("tokenOut", proposal.description) || "";
  const amountOut = decodeProposalDescription("amountOut", proposal.description) || "0";
  const slippage = decodeProposalDescription("slippage", proposal.description);
  const destinationNetwork = decodeProposalDescription("destinationNetwork", proposal.description);
  const depositAddress = args.receiver_id || "";
  const intentsTokenContractId = args.token_id?.startsWith("nep141:")
    ? args.token_id.replace("nep141:", "")
    : args.token_id;
  const quoteDeadline = decodeProposalDescription("quoteDeadline", proposal.description);
  const quoteSignature = decodeProposalDescription("signature", proposal.description);
  const timeEstimate = decodeProposalDescription("timeEstimate", proposal.description);


  return {
    source: "exchange",
    tokenIn: args.receiver_id === "v2.ref-finance.near" ? functionCall.receiver_id : args.token_id || "",
    intentsTokenContractId,
    amountIn,
    tokenOut,
    amountOut,
    destinationNetwork,
    sourceNetwork: "near", // As from mt_transfer_call
    quoteSignature,
    depositAddress,
    timeEstimate: timeEstimate || undefined,
    slippage: slippage || undefined,
    quoteDeadline: quoteDeadline || undefined,
  };
}

export function extractNearWrapSwapRequestData(proposal: Proposal): SwapRequestData {
  if (!("FunctionCall" in proposal.kind)) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  const functionCall = proposal.kind.FunctionCall;
  const action = functionCall.actions.find(
    (a) => a.method_name === "near_withdraw" || a.method_name === "near_deposit"
  );
  if (!action) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  const args = decodeArgs(action.args);
  if (!args) {
    throw new Error("Proposal is not a Exchange proposal");
  }
  const isWrap = action.method_name === "near_deposit";
  const amount = isWrap ? action.deposit || "0" : args.amount || "0";

  return {
    source: "wrap.near",
    tokenIn: isWrap ? "near" : "wrap.near",
    amountIn: amount,
    tokenOut: isWrap ? "wrap.near" : "near",
    amountOut: amount,
    destinationNetwork: "near",
    sourceNetwork: "near",
  };
}

/**
 * Extract Batch Payment Request data from proposal
 */
export function extractBatchPaymentRequestData(proposal: Proposal): BatchPaymentRequestData {
  if (!("FunctionCall" in proposal.kind)) {
    throw new Error("Proposal is not a Batch Payment Request proposal");
  }

  const functionCall = proposal.kind.FunctionCall;
  const action = functionCall.actions.find(
    (a) => a.method_name === "ft_transfer_call" || a.method_name === "approve_list"
  );


  if (!action) {
    throw new Error("Proposal is not a Batch Payment Request proposal");
  }

  const args = decodeArgs(action.args);
  if (!args) {
    throw new Error("Proposal is not a Batch Payment Request proposal");
  }

  if (action.method_name === "approve_list") {
    return {
      tokenId: "NEAR",
      totalAmount: action.deposit,
      batchId: args.list_id || "",
    }
  }



  return {
    tokenId: functionCall.receiver_id,
    totalAmount: args.amount || "0",
    batchId: String(args.msg) || "",
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
export function extractSetStakingContractData(proposal: Proposal): SetStakingContractData {
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
export function extractFactoryInfoUpdateData(proposal: Proposal): FactoryInfoUpdateData {
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
    proposalType
  };
}

/**
 * Main extractor that routes to the appropriate extractor based on proposal type
 */
export function extractProposalData(proposal: Proposal): {
  type: ProposalUIKind;
  data: AnyProposalData;
} {
  const type = getProposalUIKind(proposal);
  let data: AnyProposalData;

  switch (type) {
    case "Payment Request":
      data = extractPaymentRequestData(proposal);
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
        if (proposal.kind.FunctionCall.receiver_id === 'wrap.near') {
          data = extractNearWrapSwapRequestData(proposal);
        } else {
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
