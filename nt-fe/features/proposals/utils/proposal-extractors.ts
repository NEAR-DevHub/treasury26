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
  PolicyChange,
  RoleChange,
  VotePolicyChange,
  MemberRoleChange,
  RoleDefinitionChange,
} from "../types/index";
import { getProposalUIKind } from "./proposal-utils";
import { ProposalUIKind } from "../types/index";
import { Policy } from "@/types/policy";
import { TreasuryConfig } from "@/lib/api";
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

  return {
    tokenId,
    amount,
    receiver,
    notes: notes || "",
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
 * Helper function to compute member-level role changes
 * A member can belong to multiple roles (groups)
 */
function computeMemberRoleChanges(currentPolicy: Policy, newPolicy: Policy): RoleChange {
  const addedMembers: MemberRoleChange[] = [];
  const removedMembers: MemberRoleChange[] = [];
  const updatedMembers: MemberRoleChange[] = [];
  const roleDefinitionChanges: RoleDefinitionChange[] = [];

  // Create a map of current member -> roles (array of role names)
  const currentMemberRoles = new Map<string, string[]>();
  for (const role of currentPolicy?.roles || []) {
    if (typeof role.kind === "object" && "Group" in role.kind) {
      for (const member of role.kind.Group) {
        const existing = currentMemberRoles.get(member) || [];
        currentMemberRoles.set(member, [...existing, role.name]);
      }
    }
  }

  // Create a map of new member -> roles (array of role names)
  const newMemberRoles = new Map<string, string[]>();
  for (const role of newPolicy.roles) {
    if (typeof role.kind === "object" && "Group" in role.kind) {
      for (const member of role.kind.Group) {
        const existing = newMemberRoles.get(member) || [];
        newMemberRoles.set(member, [...existing, role.name]);
      }
    }
  }

  // Get all unique members
  const allMembers = new Set([...currentMemberRoles.keys(), ...newMemberRoles.keys()]);

  for (const member of allMembers) {
    const oldRoles = currentMemberRoles.get(member) || [];
    const newRoles = newMemberRoles.get(member) || [];

    // Sort for comparison
    const oldRolesSorted = [...oldRoles].sort();
    const newRolesSorted = [...newRoles].sort();

    if (oldRoles.length === 0 && newRoles.length > 0) {
      // Member was added
      addedMembers.push({
        member,
        newRoles: newRolesSorted,
      });
    } else if (oldRoles.length > 0 && newRoles.length === 0) {
      // Member was removed
      removedMembers.push({
        member,
        oldRoles: oldRolesSorted,
      });
    } else if (JSON.stringify(oldRolesSorted) !== JSON.stringify(newRolesSorted)) {
      // Member's roles changed
      updatedMembers.push({
        member,
        oldRoles: oldRolesSorted,
        newRoles: newRolesSorted,
      });
    }
  }

  // Compare role definitions (vote policies and permissions)
  const currentRoleMap = new Map(currentPolicy?.roles?.map(r => [r.name, r]) || []);
  const newRoleMap = new Map(newPolicy.roles.map(r => [r.name, r]));

  // Check all roles that exist in both policies
  for (const [roleName, newRole] of newRoleMap) {
    const oldRole = currentRoleMap.get(roleName);
    if (!oldRole) continue; // Skip newly added roles (they don't have old values to compare)

    // For each proposal kind in the role's vote_policy
    for (const [proposalKind, newVotePolicy] of Object.entries(newRole.vote_policy)) {
      const oldVotePolicy = oldRole.vote_policy[proposalKind];
      if (!oldVotePolicy) continue; // Skip if this proposal kind didn't exist before

      const hasChanges =
        oldVotePolicy.weight_kind !== newVotePolicy.weight_kind ||
        oldVotePolicy.quorum !== newVotePolicy.quorum ||
        JSON.stringify(oldVotePolicy.threshold) !== JSON.stringify(newVotePolicy.threshold);

      const permissionsChanged =
        JSON.stringify([...oldRole.permissions].sort()) !== JSON.stringify([...newRole.permissions].sort());

      if (hasChanges || permissionsChanged) {
        roleDefinitionChanges.push({
          roleName,
          proposalKind,
          oldThreshold: oldVotePolicy.threshold,
          newThreshold: newVotePolicy.threshold,
          oldQuorum: oldVotePolicy.quorum,
          newQuorum: newVotePolicy.quorum,
          oldWeightKind: oldVotePolicy.weight_kind,
          newWeightKind: newVotePolicy.weight_kind,
          oldPermissions: permissionsChanged ? oldRole.permissions : undefined,
          newPermissions: permissionsChanged ? newRole.permissions : undefined,
        });
      }
    }
  }

  return {
    addedMembers,
    removedMembers,
    updatedMembers,
    roleDefinitionChanges,
  };
}

/**
 * Extract Change Policy data from proposal and compute diffs
 */
export function extractChangePolicyData(proposal: Proposal, currentPolicy: Policy): ChangePolicyData {
  const policyChanges: PolicyChange[] = [];
  let roleChanges: RoleChange = {
    addedMembers: [],
    removedMembers: [],
    updatedMembers: [],
    roleDefinitionChanges: [],
  };
  const defaultVotePolicyChanges: VotePolicyChange[] = [];

  if ("ChangePolicy" in proposal.kind) {
    const newPolicy = proposal.kind.ChangePolicy.policy as Policy;

    // Compare policy parameters
    if (currentPolicy?.proposal_bond !== newPolicy?.proposal_bond) {
      policyChanges.push({
        field: "proposal_bond",
        oldValue: currentPolicy?.proposal_bond || "0",
        newValue: newPolicy.proposal_bond,
      });
    }
    if (currentPolicy?.proposal_period !== newPolicy?.proposal_period) {
      policyChanges.push({
        field: "proposal_period",
        oldValue: currentPolicy?.proposal_period || "0",
        newValue: newPolicy.proposal_period,
      });
    }
    if (currentPolicy?.bounty_bond !== newPolicy?.bounty_bond) {
      policyChanges.push({
        field: "bounty_bond",
        oldValue: currentPolicy?.bounty_bond || "0",
        newValue: newPolicy.bounty_bond,
      });
    }
    if (currentPolicy?.bounty_forgiveness_period !== newPolicy?.bounty_forgiveness_period) {
      policyChanges.push({
        field: "bounty_forgiveness_period",
        oldValue: currentPolicy?.bounty_forgiveness_period || "0",
        newValue: newPolicy.bounty_forgiveness_period,
      });
    }

    // Compare roles at member level
    roleChanges = computeMemberRoleChanges(currentPolicy, newPolicy);

    // Compare default vote policy
    const oldVP = currentPolicy?.default_vote_policy;
    const newVP = newPolicy.default_vote_policy;
    if (oldVP?.weight_kind !== newVP.weight_kind) {
      defaultVotePolicyChanges.push({
        field: "weight_kind",
        oldValue: oldVP?.weight_kind,
        newValue: newVP.weight_kind,
      });
    }
    if (oldVP?.quorum !== newVP.quorum) {
      defaultVotePolicyChanges.push({
        field: "quorum",
        oldValue: oldVP?.quorum,
        newValue: newVP.quorum,
      });
    }
    if (JSON.stringify(oldVP?.threshold) !== JSON.stringify(newVP.threshold)) {
      defaultVotePolicyChanges.push({
        field: "threshold",
        oldValue: oldVP?.threshold,
        newValue: newVP.threshold,
      });
    }
  }

  if ("ChangePolicyUpdateParameters" in proposal.kind) {
    const parameters = proposal.kind.ChangePolicyUpdateParameters.parameters;

    if (parameters?.proposal_bond !== null && parameters?.proposal_bond !== currentPolicy?.proposal_bond) {
      policyChanges.push({
        field: "proposal_bond",
        oldValue: currentPolicy.proposal_bond,
        newValue: parameters.proposal_bond,
      });
    }
    if (parameters?.proposal_period !== null && parameters?.proposal_period !== currentPolicy?.proposal_period) {
      policyChanges.push({
        field: "proposal_period",
        oldValue: currentPolicy?.proposal_period,
        newValue: parameters.proposal_period,
      });
    }
    if (parameters?.bounty_bond !== null && parameters?.bounty_bond !== currentPolicy?.bounty_bond) {
      policyChanges.push({
        field: "bounty_bond",
        oldValue: currentPolicy?.bounty_bond,
        newValue: parameters.bounty_bond,
      });
    }
    if (
      parameters?.bounty_forgiveness_period !== null &&
      parameters?.bounty_forgiveness_period !== currentPolicy?.bounty_forgiveness_period
    ) {
      policyChanges.push({
        field: "bounty_forgiveness_period",
        oldValue: currentPolicy?.bounty_forgiveness_period,
        newValue: parameters.bounty_forgiveness_period,
      });
    }
  }

  if ("ChangePolicyAddOrUpdateRole" in proposal.kind) {
    // For single role changes, create a temporary policy with just that change
    const role = proposal.kind.ChangePolicyAddOrUpdateRole.role;
    const tempNewPolicy = { ...currentPolicy, roles: [...currentPolicy.roles] };

    const existingRoleIndex = tempNewPolicy.roles.findIndex((r: any) => r.name === role.name);
    if (existingRoleIndex >= 0) {
      tempNewPolicy.roles[existingRoleIndex] = role as any;
    } else {
      tempNewPolicy.roles.push(role as any);
    }

    roleChanges = computeMemberRoleChanges(currentPolicy, tempNewPolicy as Policy);
  }

  if ("ChangePolicyRemoveRole" in proposal.kind) {
    const roleName = proposal.kind.ChangePolicyRemoveRole.role;
    // Create a temporary policy without the removed role
    const tempNewPolicy = {
      ...currentPolicy,
      roles: currentPolicy.roles.filter((r) => r.name !== roleName),
    };

    roleChanges = computeMemberRoleChanges(currentPolicy, tempNewPolicy);
  }

  if ("ChangePolicyUpdateDefaultVotePolicy" in proposal.kind) {
    const newVotePolicy = proposal.kind.ChangePolicyUpdateDefaultVotePolicy.vote_policy;
    const oldVP = currentPolicy.default_vote_policy;

    if (oldVP.weight_kind !== newVotePolicy.weight_kind) {
      defaultVotePolicyChanges.push({
        field: "weight_kind",
        oldValue: oldVP.weight_kind,
        newValue: newVotePolicy.weight_kind,
      });
    }
    if (oldVP.quorum !== newVotePolicy.quorum) {
      defaultVotePolicyChanges.push({
        field: "quorum",
        oldValue: oldVP.quorum,
        newValue: newVotePolicy.quorum,
      });
    }
    if (JSON.stringify(oldVP.threshold) !== JSON.stringify(newVotePolicy.threshold)) {
      defaultVotePolicyChanges.push({
        field: "threshold",
        oldValue: oldVP.threshold,
        newValue: newVotePolicy.threshold,
      });
    }
  }

  return {
    policyChanges,
    roleChanges,
    defaultVotePolicyChanges,
    originalProposalKind: proposal.kind,
  };
}

/**
 * Extract Change Config data from proposal
 */
export function extractChangeConfigData(proposal: Proposal, currentConfig?: TreasuryConfig | null): ChangeConfigData {
  if (!("ChangeConfig" in proposal.kind)) {
    throw new Error("Proposal is not a Change Config proposal");
  }

  const changeConfig = proposal.kind.ChangeConfig;
  const { metadata, purpose, name } = changeConfig.config;
  const metadataFromBase64 = decodeArgs(metadata) || {};

  return {
    oldConfig: {
      name: currentConfig?.name ?? null,
      purpose: currentConfig?.purpose ?? null,
      metadata: currentConfig?.metadata ? (typeof currentConfig.metadata === 'string' ? decodeArgs(currentConfig.metadata) : currentConfig.metadata) : null,
    },
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
export function extractSwapRequestData(proposal: Proposal): SwapRequestData {
  if (!("FunctionCall" in proposal.kind)) {
    throw new Error("Proposal is not a Exchange proposal");
  }

  const functionCall = proposal.kind.FunctionCall;
  const action = functionCall.actions.find(
    (a) => a.method_name === "mt_transfer" || a.method_name === "mt_transfer_call"
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
    tokenIn: args.token_id || "",
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
export function extractProposalData(proposal: Proposal, policy: Policy, config?: TreasuryConfig | null): {
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
      data = extractChangePolicyData(proposal, policy);
      break;
    case "Update General Settings":
      data = extractChangeConfigData(proposal, config);
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
      data = extractSwapRequestData(proposal);
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
