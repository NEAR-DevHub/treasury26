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
} from "../types/index";
import { getProposalUIKind } from "./proposal-utils";
import { ProposalUIKind } from "../types/index";
import { Policy } from "@/types/policy";
import { Action } from "@hot-labs/near-connect/build/types";


function extractFTTransferData(functionCall: FunctionCallKind["FunctionCall"], actions: Action[]): Omit<PaymentRequestData, "notes"> | undefined {
  const action = actions.find(
    (a) => a.method_name === "ft_transfer" || a.method_name === "ft_transfer_call"
  );
  if (action) {
    const args = decodeArgs(action.args);
    if (args) {
      return {
        tokenId: functionCall.receiver_id,
        amount: args.amount || "0",
        receiver: args.receiver_id || "",
        network: "NEAR",
      };
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
  let network = "NEAR";

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
      network = ftTransferData.network;
    }
  } else {
    throw new Error("Proposal is not a Function Call or Transfer proposal");
  }

  const notes = decodeProposalDescription("notes", proposal.description);

  return {
    tokenId,
    amount,
    receiver,
    notes: notes || "",
    network,
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
  if (!("ChangePolicy" in proposal.kind)) {
    throw new Error("Proposal is not a Change Policy proposal");
  }

  const policy = proposal.kind.ChangePolicy.policy;

  return {
    policy: policy as Policy,
    rolesCount: policy.roles.length,
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
    name,
    purpose,
    metadata: metadataFromBase64,
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
    (action) => action.method_name === "withdraw" || action.method_name === "unstake"
  );

  const selectedAction = stakingAction || withdrawAction;
  const args = selectedAction ? decodeArgs(selectedAction.args) : null;

  const notes = decodeProposalDescription("notes", proposal.description);

  return {
    tokenId: "near",
    amount: args?.amount || "0",
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
 * Extract Swap Request data from proposal
 */
export function extractSwapRequestData(proposal: Proposal): SwapRequestData {
  if (!("FunctionCall" in proposal.kind)) {
    throw new Error("Proposal is not a Swap Request proposal");
  }

  const functionCall = proposal.kind.FunctionCall;
  const action = functionCall.actions.find(
    (a) => a.method_name === "mt_transfer" || a.method_name === "mt_transfer_call"
  );

  if (!action) {
    throw new Error("Proposal is not a Swap Request proposal");
  }

  const args = decodeArgs(action?.args);
  if (!args) {
    throw new Error("Proposal is not a Swap Request proposal");
  }

  // Extract from description
  const amountIn = args.amount || decodeProposalDescription("amountIn", proposal.description) || "0";
  const tokenOut = decodeProposalDescription("tokenOut", proposal.description) || "";
  const amountOut = decodeProposalDescription("amountOut", proposal.description) || "0";
  const slippage = decodeProposalDescription("slippage", proposal.description);
  const destinationNetwork = decodeProposalDescription("destinationNetwork", proposal.description);
  const depositAddress = args.receiver_id || "";
  const quoteDeadline = decodeProposalDescription("quoteDeadline", proposal.description);
  const quoteSignature = decodeProposalDescription("signature", proposal.description);
  const timeEstimate = decodeProposalDescription("timeEstimate", proposal.description);

  return {
    tokenIn: args.token_id || "",
    amountIn,
    tokenOut,
    amountOut,
    destinationNetwork,
    sourceNetwork: "NEAR", // As from mt_transfer_call
    quoteSignature,
    depositAddress,
    timeEstimate: timeEstimate || undefined,
    slippage: slippage || undefined,
    quoteDeadline: quoteDeadline || undefined,
  };
}

/**
 * Extract Unknown proposal data
 */
export function extractUnknownData(proposal: Proposal): UnknownData {
  return {
    message: "Unknown proposal type",
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
    case "Change Policy":
      data = extractChangePolicyData(proposal);
      break;
    case "Change Config":
      data = extractChangeConfigData(proposal);
      break;
    case "Staking":
    case "Withdraw":
      data = extractStakingData(proposal);
      break;
    case "Vesting":
      data = extractVestingData(proposal);
      break;
    case "Swap Request":
      data = extractSwapRequestData(proposal);
      break;
    case "Unknown":
    default:
      data = extractUnknownData(proposal);
      break;
  }

  return { type, data };
}
